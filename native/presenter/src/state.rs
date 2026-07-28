use std::sync::Arc;

use super::platform::{Bounds, FramePool};

const SURFACE_COUNT: i32 = 3;

#[derive(Clone)]
pub struct PendingFrame {
    pub pool_generation: u64,
    pub surface_index: i32,
    pub content_generation: u64,
}

pub struct PresenterState {
    pub last_bounds: Bounds,
    pub suspended: bool,
    pub pool_generation: u64,
    pub pool: Option<Arc<FramePool>>,
    pub pending: Option<PendingFrame>,
    pub highest_presented_content_generation: u64,
}

impl PresenterState {
    pub fn new(bounds: Bounds) -> Self {
        Self {
            last_bounds: bounds,
            suspended: false,
            pool_generation: 0,
            pool: None,
            pending: None,
            highest_presented_content_generation: 0,
        }
    }

    pub fn install_pool(
        &mut self,
        generation: u64,
        pool: Arc<FramePool>,
    ) -> Option<(Arc<FramePool>, i32)> {
        if generation < self.pool_generation {
            return None;
        }
        let surface_index = self.install_pool_decision(generation);
        self.pool = Some(pool.clone());
        surface_index.map(|surface_index| (pool, surface_index))
    }

    fn install_pool_decision(&mut self, generation: u64) -> Option<i32> {
        if generation < self.pool_generation {
            return None;
        }
        self.pool_generation = generation;
        let pending = self.pending.take()?;
        if pending.pool_generation != generation
            || !(0..SURFACE_COUNT).contains(&pending.surface_index)
            || pending.content_generation < self.highest_presented_content_generation
            || self.suspended
        {
            if pending.pool_generation > generation {
                self.pending = Some(pending);
            }
            return None;
        }
        self.highest_presented_content_generation = pending.content_generation;
        Some(pending.surface_index)
    }

    pub fn select_frame(
        &mut self,
        pool_generation: u64,
        surface_index: i32,
        content_generation: u64,
    ) -> Option<(Arc<FramePool>, i32)> {
        if self.suspended {
            return None;
        }
        if pool_generation == self.pool_generation {
            let pool = self.pool.clone()?;
            if !self.accept_current_frame(surface_index, content_generation) {
                return None;
            }
            return Some((pool, surface_index));
        }
        if pool_generation > self.pool_generation {
            let replace = self.pending.as_ref().is_none_or(|pending| {
                pool_generation > pending.pool_generation
                    || (pool_generation == pending.pool_generation
                        && content_generation >= pending.content_generation)
            });
            if replace {
                self.pending = Some(PendingFrame {
                    pool_generation,
                    surface_index,
                    content_generation,
                });
            }
        }
        None
    }

    fn accept_current_frame(&mut self, surface_index: i32, content_generation: u64) -> bool {
        if !(0..SURFACE_COUNT).contains(&surface_index)
            || content_generation < self.highest_presented_content_generation
        {
            return false;
        }
        self.pending = None;
        self.highest_presented_content_generation = content_generation;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> PresenterState {
        PresenterState::new(Bounds {
            x: 0.0,
            y: 0.0,
            width: 320.0,
            height: 180.0,
            corner_radius: 0.0,
        })
    }

    #[test]
    fn future_frame_is_flushed_when_its_pool_arrives() {
        let mut state = state();
        state.pending = Some(PendingFrame {
            pool_generation: 4,
            surface_index: 2,
            content_generation: 7,
        });

        assert_eq!(state.install_pool_decision(4), Some(2));
        assert!(state.pending.is_none());
        assert_eq!(state.highest_presented_content_generation, 7);
    }

    #[test]
    fn lower_content_generation_is_rejected() {
        let mut state = state();
        state.highest_presented_content_generation = 9;

        assert!(!state.accept_current_frame(1, 8));
        assert_eq!(state.highest_presented_content_generation, 9);
    }

    #[test]
    fn newer_pending_frame_survives_an_older_pool() {
        let mut state = state();
        state.pool_generation = 3;
        state.pending = Some(PendingFrame {
            pool_generation: 5,
            surface_index: 1,
            content_generation: 11,
        });

        assert_eq!(state.install_pool_decision(4), None);
        assert_eq!(
            state
                .pending
                .as_ref()
                .map(|pending| pending.pool_generation),
            Some(5)
        );
    }

    #[test]
    fn suspended_pool_install_drops_same_generation_pending_frame() {
        let mut state = state();
        state.suspended = true;
        state.pending = Some(PendingFrame {
            pool_generation: 2,
            surface_index: 0,
            content_generation: 3,
        });

        assert_eq!(state.install_pool_decision(2), None);
        assert!(state.pending.is_none());
    }
}
