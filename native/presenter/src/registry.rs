use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::{Arc, Mutex, OnceLock};

use super::platform::VideoPresenter;
use super::state::PresenterState;

pub struct Presenter {
    pub host: VideoPresenter,
    pub state: Mutex<PresenterState>,
}

enum PresenterEntry {
    Creating,
    Active(Arc<Presenter>),
    Destroying(Arc<Presenter>),
    DestroyFailed(Arc<Presenter>),
}

static PRESENTERS: OnceLock<Mutex<HashMap<String, PresenterEntry>>> = OnceLock::new();

fn presenters() -> &'static Mutex<HashMap<String, PresenterEntry>> {
    PRESENTERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct PresenterReservation {
    id: String,
    committed: bool,
}

impl PresenterReservation {
    pub fn commit(mut self, presenter: Arc<Presenter>) -> Result<(), String> {
        let mut entries = presenters()
            .lock()
            .map_err(|_| "empv presenter bridge registry lock was poisoned.".to_owned())?;
        match entries.entry(self.id.clone()) {
            Entry::Occupied(mut entry) if matches!(entry.get(), PresenterEntry::Creating) => {
                entry.insert(PresenterEntry::Active(presenter));
                self.committed = true;
                Ok(())
            }
            Entry::Occupied(_) => Err(format!(
                "empv presenter {} cannot finish creation because its registry entry is already active.",
                self.id
            )),
            Entry::Vacant(_) => Err(format!(
                "empv presenter {} cannot finish creation because its registry reservation is missing.",
                self.id
            )),
        }
    }
}

impl Drop for PresenterReservation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        if let Ok(mut entries) = presenters().lock()
            && let Entry::Occupied(entry) = entries.entry(self.id.clone())
            && matches!(entry.get(), PresenterEntry::Creating)
        {
            entry.remove();
        }
    }
}

pub fn reserve(id: String) -> Result<PresenterReservation, String> {
    if id.trim().is_empty() {
        return Err("empv presenter id must not be empty.".to_owned());
    }
    let mut entries = presenters()
        .lock()
        .map_err(|_| "empv presenter bridge registry lock was poisoned.".to_owned())?;
    match entries.entry(id.clone()) {
        Entry::Vacant(entry) => {
            entry.insert(PresenterEntry::Creating);
            Ok(PresenterReservation {
                id,
                committed: false,
            })
        }
        Entry::Occupied(_) => Err(format!("empv presenter {id} already exists.")),
    }
}

pub fn find(id: &str) -> Result<Option<Arc<Presenter>>, String> {
    let entries = presenters()
        .lock()
        .map_err(|_| "empv presenter bridge registry lock was poisoned.".to_owned())?;
    Ok(match entries.get(id) {
        Some(PresenterEntry::Active(presenter)) => Some(presenter.clone()),
        Some(
            PresenterEntry::Creating
            | PresenterEntry::Destroying(_)
            | PresenterEntry::DestroyFailed(_),
        )
        | None => None,
    })
}

pub fn get(id: &str) -> Result<Arc<Presenter>, String> {
    let entries = presenters()
        .lock()
        .map_err(|_| "empv presenter bridge registry lock was poisoned.".to_owned())?;
    match entries.get(id) {
        Some(PresenterEntry::Active(presenter)) => Ok(presenter.clone()),
        Some(PresenterEntry::Creating) => {
            Err(format!("empv presenter {id} is still being created."))
        }
        Some(PresenterEntry::Destroying(_)) => {
            Err(format!("empv presenter {id} destruction is in progress."))
        }
        Some(PresenterEntry::DestroyFailed(_)) => Err(format!(
            "empv presenter {id} cannot be used because its previous destruction failed; retry destroyPresenter."
        )),
        None => Err(format!("empv presenter {id} does not exist.")),
    }
}

pub struct PresenterDestruction {
    id: String,
    presenter: Arc<Presenter>,
    completed: bool,
}

impl PresenterDestruction {
    pub fn presenter(&self) -> &Presenter {
        &self.presenter
    }

    pub fn commit(mut self) -> Result<(), String> {
        let mut entries = presenters()
            .lock()
            .map_err(|_| "empv presenter bridge registry lock was poisoned.".to_owned())?;
        match entries.remove(&self.id) {
            Some(PresenterEntry::Destroying(_)) => {
                self.completed = true;
                Ok(())
            }
            Some(entry) => {
                entries.insert(self.id.clone(), entry);
                Err(format!(
                    "empv presenter {} cannot finish destruction because it is not being destroyed.",
                    self.id
                ))
            }
            None => Err(format!(
                "empv presenter {} cannot finish destruction because its registry entry is missing.",
                self.id
            )),
        }
    }

    pub fn record_failure(mut self) -> Result<(), String> {
        let mut entries = presenters()
            .lock()
            .map_err(|_| "empv presenter bridge registry lock was poisoned.".to_owned())?;
        match entries.remove(&self.id) {
            Some(PresenterEntry::Destroying(presenter)) => {
                entries.insert(self.id.clone(), PresenterEntry::DestroyFailed(presenter));
                self.completed = true;
                Ok(())
            }
            Some(entry) => {
                entries.insert(self.id.clone(), entry);
                Err(format!(
                    "empv presenter {} cannot record a destruction failure because it is not being destroyed.",
                    self.id
                ))
            }
            None => Err(format!(
                "empv presenter {} cannot record a destruction failure because its registry entry is missing.",
                self.id
            )),
        }
    }
}

impl Drop for PresenterDestruction {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        if let Ok(mut entries) = presenters().lock()
            && let Some(PresenterEntry::Destroying(presenter)) = entries.remove(&self.id)
        {
            entries.insert(self.id.clone(), PresenterEntry::DestroyFailed(presenter));
        }
    }
}

pub fn begin_destruction(id: &str) -> Result<Option<PresenterDestruction>, String> {
    let mut entries = presenters()
        .lock()
        .map_err(|_| "empv presenter bridge registry lock was poisoned.".to_owned())?;
    let presenter = match entries.entry(id.to_owned()) {
        Entry::Vacant(_) => return Ok(None),
        Entry::Occupied(entry) if matches!(entry.get(), PresenterEntry::Creating) => {
            return Err(format!(
                "empv presenter {id} cannot be destroyed while creation is in progress."
            ));
        }
        Entry::Occupied(entry) if matches!(entry.get(), PresenterEntry::Destroying(_)) => {
            return Err(format!(
                "empv presenter {id} destruction is already in progress."
            ));
        }
        Entry::Occupied(mut entry) => {
            let presenter = match entry.get() {
                PresenterEntry::Active(presenter) | PresenterEntry::DestroyFailed(presenter) => {
                    presenter.clone()
                }
                PresenterEntry::Creating | PresenterEntry::Destroying(_) => unreachable!(),
            };
            entry.insert(PresenterEntry::Destroying(presenter.clone()));
            presenter
        }
    };
    Ok(Some(PresenterDestruction {
        id: id.to_owned(),
        presenter,
        completed: false,
    }))
}
