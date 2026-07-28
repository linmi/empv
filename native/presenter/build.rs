use std::env;

fn main() {
    napi_build::setup();

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "macos" {
        return;
    }

    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    let deployment_target =
        env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "11.0".to_owned());
    let deployment_flag = format!("-mmacosx-version-min={deployment_target}");
    for source in [
        "../shims/macos/native_platform.h",
        "../shims/macos/native_platform_internal.h",
        "../shims/macos/frame_link.mm",
        "../shims/macos/presenter.mm",
        "../shims/macos/window.mm",
    ] {
        println!("cargo:rerun-if-changed={source}");
    }

    cc::Build::new()
        .cpp(true)
        .files([
            "../shims/macos/frame_link.mm",
            "../shims/macos/presenter.mm",
            "../shims/macos/window.mm",
        ])
        .include("../shims/macos")
        .define("EMPV_MAC_FRAME_LINK_RECEIVER", None)
        .define("GL_SILENCE_DEPRECATION", None)
        .flag("-fobjc-arc")
        .flag(&deployment_flag)
        .flag_if_supported("-std=c++20")
        .compile("empv_presenter_macos_platform");

    for framework in ["AppKit", "Foundation", "IOSurface", "QuartzCore"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rustc-link-arg={deployment_flag}");
    println!("cargo:rustc-cdylib-link-arg=-Wl,-install_name,@loader_path/empv_presenter.node");
}
