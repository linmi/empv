use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    napi_build::setup();

    println!("cargo:rerun-if-env-changed=LIBMPV_LIBRARY_DIR");
    println!("cargo:rerun-if-env-changed=LIBMPV_IMPORT_LIB");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    match target_os.as_str() {
        "macos" => build_macos_shims(),
        "linux" => build_linux_wid(),
        "windows" => build_windows_wid(),
        _ => {}
    }
}

fn build_macos_shims() {
    let deployment_target =
        env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "11.0".to_owned());
    let deployment_flag = format!("-mmacosx-version-min={deployment_target}");
    for source in [
        "shims/macos/native_platform.h",
        "shims/macos/native_platform_internal.h",
        "shims/macos/session_surface.mm",
        "shims/macos/frame_link.mm",
        "shims/macos/presenter.mm",
        "shims/macos/window.mm",
    ] {
        println!("cargo:rerun-if-changed={source}");
    }

    cc::Build::new()
        .cpp(true)
        .files([
            "shims/macos/session_surface.mm",
            "shims/macos/frame_link.mm",
            "shims/macos/presenter.mm",
            "shims/macos/window.mm",
        ])
        .include("shims/macos")
        .define("GL_SILENCE_DEPRECATION", None)
        .flag("-fobjc-arc")
        .flag(&deployment_flag)
        .flag_if_supported("-std=c++20")
        .compile("empv_macos_platform");

    let library = resolve_macos_library();
    println!(
        "cargo:rustc-link-search=native={}",
        library.link_dir.display()
    );
    println!("cargo:rustc-link-lib=dylib=mpv");
    for framework in [
        "AppKit",
        "CoreVideo",
        "Foundation",
        "IOSurface",
        "OpenGL",
        "QuartzCore",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rustc-link-arg={deployment_flag}");
    println!("cargo:rustc-cdylib-link-arg=-Wl,-install_name,@loader_path/empv.node");
    if let Some(runtime_rpath) = library.runtime_rpath {
        println!(
            "cargo:rustc-link-arg=-Wl,-rpath,{}",
            runtime_rpath.display()
        );
    }
    println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path/lib");
}

struct MacosLibrary {
    link_dir: PathBuf,
    runtime_rpath: Option<PathBuf>,
}

fn resolve_macos_library() -> MacosLibrary {
    if let Some(library_dir) = env::var_os("LIBMPV_LIBRARY_DIR").map(PathBuf::from) {
        validate_macos_library_dir(&library_dir);
        return MacosLibrary {
            link_dir: library_dir,
            runtime_rpath: None,
        };
    }

    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let runtime_arch = match target_arch.as_str() {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => panic!(
            "No vendored macOS libmpv runtime is defined for target architecture `{target_arch}`."
        ),
    };
    let manifest_dir = match env::var_os("CARGO_MANIFEST_DIR") {
        Some(manifest_dir) => PathBuf::from(manifest_dir),
        None => panic!("Cargo did not provide CARGO_MANIFEST_DIR to the libmpv build."),
    };
    let vendor_dir = manifest_dir
        .join("..")
        .join("vendor")
        .join("embedded-mpv")
        .join(format!("darwin-{runtime_arch}"))
        .join("lib");
    validate_macos_library_dir(&vendor_dir);
    println!("cargo:rerun-if-changed={}", vendor_dir.display());

    let staged_dir = stage_macos_test_runtime(&vendor_dir);
    MacosLibrary {
        link_dir: staged_dir.clone(),
        runtime_rpath: Some(staged_dir),
    }
}

fn validate_macos_library_dir(library_dir: &Path) {
    let has_linkable_libmpv = ["libmpv.dylib", "libmpv.2.dylib"]
        .iter()
        .any(|name| library_dir.join(name).is_file());
    if !has_linkable_libmpv {
        panic!(
            "The macOS libmpv library directory does not contain libmpv.dylib or libmpv.2.dylib: {}",
            library_dir.display()
        );
    }
}

fn stage_macos_test_runtime(vendor_dir: &Path) -> PathBuf {
    let out_dir = match env::var_os("OUT_DIR") {
        Some(out_dir) => PathBuf::from(out_dir),
        None => panic!("Cargo did not provide OUT_DIR to the libmpv build."),
    };
    let staged_dir = out_dir.join("libmpv-runtime");
    if staged_dir.exists()
        && let Err(error) = fs::remove_dir_all(&staged_dir)
    {
        panic!(
            "Failed to clear the Cargo-local libmpv runtime directory {}: {error}",
            staged_dir.display()
        );
    }
    if let Err(error) = fs::create_dir_all(&staged_dir) {
        panic!(
            "Failed to create the Cargo-local libmpv runtime directory {}: {error}",
            staged_dir.display()
        );
    }

    let entries = match fs::read_dir(vendor_dir) {
        Ok(entries) => entries,
        Err(error) => panic!(
            "Failed to read the vendored libmpv directory {}: {error}",
            vendor_dir.display()
        ),
    };
    let mut staged_libraries = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => panic!("Failed to inspect a vendored libmpv entry: {error}"),
        };
        let source = entry.path();
        if source.extension().and_then(|extension| extension.to_str()) != Some("dylib") {
            continue;
        }
        println!("cargo:rerun-if-changed={}", source.display());
        let destination = staged_dir.join(entry.file_name());
        if let Err(error) = fs::copy(&source, &destination) {
            panic!(
                "Failed to stage {} at {}: {error}",
                source.display(),
                destination.display()
            );
        }
        staged_libraries.push(destination);
    }
    if staged_libraries.is_empty() {
        panic!(
            "The vendored macOS libmpv runtime has no dylibs: {}",
            vendor_dir.display()
        );
    }

    let staged_names = staged_libraries
        .iter()
        .filter_map(|library| library.file_name().and_then(|name| name.to_str()))
        .map(str::to_owned)
        .collect::<std::collections::HashSet<_>>();
    for library in &staged_libraries {
        patch_macos_runtime_library(library, &staged_names);
    }
    staged_dir
}

fn patch_macos_runtime_library(library: &Path, staged_names: &std::collections::HashSet<String>) {
    let library_name = match library.file_name().and_then(|name| name.to_str()) {
        Some(name) => name,
        None => panic!("Invalid staged dylib path: {}", library.display()),
    };
    run_macos_tool(
        "/usr/bin/install_name_tool",
        &[
            "-id".into(),
            format!("@rpath/{library_name}").into(),
            library.as_os_str().to_owned(),
        ],
    );

    let output = match Command::new("/usr/bin/otool")
        .arg("-L")
        .arg(library)
        .output()
    {
        Ok(output) if output.status.success() => output,
        Ok(output) => panic!(
            "otool failed for {} with status {}.",
            library.display(),
            output.status
        ),
        Err(error) => panic!("Failed to run otool for {}: {error}", library.display()),
    };
    let dependencies = String::from_utf8_lossy(&output.stdout);
    for dependency in dependencies
        .lines()
        .skip(1)
        .filter_map(|line| line.split_whitespace().next().map(str::to_owned))
    {
        let Some(dependency_name) = Path::new(&dependency)
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned)
        else {
            continue;
        };
        if !staged_names.contains(&dependency_name) {
            continue;
        }
        run_macos_tool(
            "/usr/bin/install_name_tool",
            &[
                "-change".into(),
                dependency.into(),
                format!("@rpath/{dependency_name}").into(),
                library.as_os_str().to_owned(),
            ],
        );
    }
}

fn run_macos_tool(tool: &str, arguments: &[std::ffi::OsString]) {
    match Command::new(tool).args(arguments).status() {
        Ok(status) if status.success() => {}
        Ok(status) => panic!("{tool} failed with status {status}."),
        Err(error) => panic!("Failed to run {tool}: {error}"),
    }
}

fn build_linux_wid() {
    println!("cargo:rerun-if-changed=shims/wid/native_window.h");
    println!("cargo:rerun-if-changed=shims/wid/native_window_x11.cc");

    cc::Build::new()
        .cpp(true)
        .file("shims/wid/native_window_x11.cc")
        .flag_if_supported("-std=c++20")
        .compile("empv_native_window");

    if let Some(library_dir) = env::var_os("LIBMPV_LIBRARY_DIR") {
        println!(
            "cargo:rustc-link-search=native={}",
            PathBuf::from(library_dir).display()
        );
    }
    println!("cargo:rustc-link-lib=dylib=mpv");
    println!("cargo:rustc-link-lib=dylib=X11");
    println!("cargo:rustc-link-lib=dylib=Xext");
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/lib");
}

fn build_windows_wid() {
    println!("cargo:rerun-if-changed=shims/wid/native_window.h");
    println!("cargo:rerun-if-changed=shims/wid/native_window_win32.cc");

    cc::Build::new()
        .cpp(true)
        .file("shims/wid/native_window_win32.cc")
        .define("WIN32_LEAN_AND_MEAN", None)
        .define("NOMINMAX", None)
        .flag_if_supported("/std:c++20")
        .flag_if_supported("/EHsc")
        .compile("empv_native_window");

    if let Some(import_lib) = env::var_os("LIBMPV_IMPORT_LIB") {
        let import_lib = PathBuf::from(import_lib);
        if let Some(parent) = import_lib.parent() {
            println!("cargo:rustc-link-search=native={}", parent.display());
        }
        link_windows_import_library(&import_lib);
    } else {
        if let Some(library_dir) = env::var_os("LIBMPV_LIBRARY_DIR") {
            println!(
                "cargo:rustc-link-search=native={}",
                PathBuf::from(library_dir).display()
            );
        }
        println!("cargo:rustc-link-lib=dylib=mpv");
    }

    println!("cargo:rustc-link-lib=dylib=user32");
    println!("cargo:rustc-link-lib=dylib=gdi32");
}

fn link_windows_import_library(import_lib: &Path) {
    match import_lib.file_stem().and_then(|stem| stem.to_str()) {
        Some(stem) => println!("cargo:rustc-link-lib=dylib={stem}"),
        None => println!("cargo:rustc-link-arg={}", import_lib.display()),
    }
}
