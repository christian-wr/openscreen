//! The extra cameras (k >= 1) a camera layout region draws, shared by the live preview
//! (`live.rs`) and the export walk (`timeline_walk.rs`).
//!
//! Index convention: camera 0 is the clip's `webcam`; camera k >= 1 is
//! `additional_cameras[k - 1]`. Only the cameras a non-empty layout region shows are opened,
//! and each is decoded only near those regions (`extra_camera_active`). Unlike camera 0, an
//! extra camera never shortens a clip and never holds its last picture: past its end its
//! layer disappears.

use crate::camera_layers::MAX_EXTRA_CAMERAS;
use crate::ffi::AVFrame;
use crate::live::PREFETCH_LEAD_SEC;
use crate::pipeline::Decoder;
use crate::scene::{SceneCameraLayoutRegion, SceneClipCamera};
use crate::timeline_walk::{frame_step, FrameStep, NextFrameTime};
use anyhow::Result;
use std::collections::{HashMap, HashSet};

/// An extra camera of an export clip: its file and its offset
/// (camera source time = screen source time - `offset_sec`).
pub type ClipCamera = SceneClipCamera;

/// What a clip opens for its extra cameras: index k-1 = camera k, `None` = not opened (no
/// layout region of the clip shows it, or the clip has no file for it). No extra camera at all
/// is the empty list.
pub(crate) type ExtraCameraKeys = Vec<Option<SceneClipCamera>>;

/// Re-seek an extra camera instead of decoding forward when its target is further ahead than
/// this (it sat idle between two regions).
pub(crate) const EXTRA_RESEEK_SEC: f64 = 1.0;

/// Camera indices >= 1 that the non-empty `regions` draw, sorted, without duplicates.
pub(crate) fn cameras_in_regions(regions: &[SceneCameraLayoutRegion]) -> Vec<usize> {
    let mut cameras: Vec<usize> = regions
        .iter()
        .filter(|r| r.end_sec > r.start_sec)
        .flat_map(|r| r.layers.iter().map(|l| l.camera))
        .filter(|camera| (1..=MAX_EXTRA_CAMERAS).contains(camera))
        .collect();
    cameras.sort_unstable();
    cameras.dedup();
    cameras
}

pub(crate) fn has_camera_file(camera: Option<&SceneClipCamera>) -> bool {
    camera.is_some_and(|c| !c.path.trim().is_empty())
}

/// The slots to open for `cameras` from a clip's camera files (`sources[k-1]` = camera k).
pub(crate) fn extra_camera_keys(cameras: &[usize], sources: &[SceneClipCamera]) -> ExtraCameraKeys {
    let mut keys: ExtraCameraKeys = (1..=MAX_EXTRA_CAMERAS)
        .map(|k| {
            let source = sources.get(k - 1);
            if cameras.contains(&k) && has_camera_file(source) {
                source.cloned()
            } else {
                None
            }
        })
        .collect();
    while keys.last().is_some_and(|k| k.is_none()) {
        keys.pop();
    }
    keys
}

/// Is extra camera `camera` near one of its layout regions at screen source time `t` — from
/// `PREFETCH_LEAD_SEC` before the region to its end? Outside, its decoder stays idle.
pub(crate) fn extra_camera_active(regions: &[SceneCameraLayoutRegion], camera: usize, t: f64) -> bool {
    regions.iter().any(|r| {
        r.end_sec > r.start_sec
            && r.layers.iter().any(|l| l.camera == camera)
            && (r.start_sec - PREFETCH_LEAD_SEC..=r.end_sec).contains(&t)
    })
}

/// A camera's source time at screen source time `screen_t` (`camera = screen - offset`),
/// never before the file's start. Camera 0 (`live.rs`) and the extra cameras share it.
pub(crate) fn camera_source_time(screen_t: f64, offset_sec: f64) -> f64 {
    (screen_t - offset_sec).max(0.0)
}

/// An extra camera's open result: a file that will not open is `None` with one warning line,
/// and its layer is skipped — never drawn from another source.
pub(crate) fn opened_or_skipped<T>(path: &str, opened: Result<T>) -> Option<T> {
    match opened {
        Ok(dec) => Some(dec),
        Err(e) => {
            eprintln!("WARNING: extra camera unreadable ({path}): {e:#}. Its layer will not be drawn.");
            None
        }
    }
}

/// Opens `path` into `decs` once. A file that will not open is remembered in `unreadable`
/// and never tried again, so its layer is skipped for the whole export. `true` when `decs`
/// holds a decoder for `path`.
pub(crate) fn open_once<T>(
    decs: &mut HashMap<String, T>,
    unreadable: &mut HashSet<String>,
    path: &str,
    open: impl FnOnce(&str) -> Result<T>,
) -> bool {
    if decs.contains_key(path) {
        return true;
    }
    if unreadable.contains(path) {
        return false;
    }
    match opened_or_skipped(path, open(path)) {
        Some(dec) => {
            decs.insert(path.to_string(), dec);
            true
        }
        None => {
            unreadable.insert(path.to_string());
            false
        }
    }
}

/// The list `set_extra_camera_frames` takes: null for an empty slot, else `frame` of the camera
/// (itself null when it has nothing to show).
pub(crate) fn extra_frame_list<T>(
    extra: &[Option<T>],
    frame: impl Fn(&T) -> *const AVFrame,
) -> Vec<*const AVFrame> {
    extra.iter().map(|slot| slot.as_ref().map_or(std::ptr::null(), &frame)).collect()
}

/// Advances `dec` to `target` (camera source time) with the webcam's hold semantics
/// (`frame_step`); re-seeks after an idle stretch or a jump back. Null past the camera's last
/// frame. `ended_at` is the camera source time past which the file has no frame left: the
/// decoder is not asked again until the target moves back before it.
pub(crate) unsafe fn step_extra_camera(
    dec: &mut Decoder,
    ended_at: &mut Option<f64>,
    target: f64,
) -> Result<*const AVFrame> {
    if ended_at.is_some_and(|end| target >= end) {
        return Ok(std::ptr::null());
    }
    let frame_dur = 1.0 / dec.fps().max(1.0);
    let cur = dec.cur_frame();
    let far = cur.is_null() || {
        let t = dec.cur_time_sec();
        target < t - frame_dur * 0.5 || target > t + EXTRA_RESEEK_SEC
    };
    let frame = if far {
        dec.seek_to(target)?
    } else {
        let mut frame = cur;
        let mut guard = 0u32;
        loop {
            let next = dec.peek_next_time_sec()?;
            // Unlike camera 0, an extra camera does not hold its last picture: past its
            // end (one frame's worth of slack) its layer disappears.
            if matches!(next, NextFrameTime::Eof) && target > dec.cur_time_sec() + frame_dur {
                frame = std::ptr::null_mut();
                break;
            }
            match frame_step(next, 0.0, target) {
                FrameStep::Commit => frame = dec.commit_peek()?,
                FrameStep::CommitAndStop => {
                    frame = dec.commit_peek()?;
                    break;
                }
                FrameStep::Hold => break,
            }
            guard += 1;
            if guard > 1000 {
                break;
            }
        }
        frame
    };
    Ok(settle(ended_at, frame, target))
}

/// Seeks `dec` to `target` (camera source time). Null past the camera's last frame.
pub(crate) unsafe fn seek_extra_camera(
    dec: &mut Decoder,
    ended_at: &mut Option<f64>,
    target: f64,
) -> Result<*const AVFrame> {
    if ended_at.is_some_and(|end| target >= end) {
        return Ok(std::ptr::null());
    }
    let frame = dec.seek_to(target)?;
    Ok(settle(ended_at, frame, target))
}

fn settle(ended_at: &mut Option<f64>, frame: *mut AVFrame, target: f64) -> *const AVFrame {
    *ended_at = if frame.is_null() { Some(target) } else { None };
    frame
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::anyhow;

    #[test]
    fn export_skips_an_extra_camera_that_will_not_open() {
        let mut decs: HashMap<String, u32> = HashMap::new();
        let mut unreadable = HashSet::new();
        let mut attempts = 0;
        let mut refuse = |_: &str| -> Result<u32> {
            attempts += 1;
            Err(anyhow!("no such file"))
        };
        assert!(!open_once(&mut decs, &mut unreadable, "/cam2.mp4", &mut refuse));
        // A later clip of the same export does not try the file again.
        assert!(!open_once(&mut decs, &mut unreadable, "/cam2.mp4", &mut refuse));
        assert_eq!(attempts, 1);
        assert!(decs.is_empty());

        // A readable camera opens once and is reused by the next clip.
        let mut opens = 0;
        let mut accept = |_: &str| -> Result<u32> {
            opens += 1;
            Ok(7)
        };
        assert!(open_once(&mut decs, &mut unreadable, "/cam3.mp4", &mut accept));
        assert!(open_once(&mut decs, &mut unreadable, "/cam3.mp4", &mut accept));
        assert_eq!(opens, 1);
        assert_eq!(decs.get("/cam3.mp4"), Some(&7));
    }

    #[test]
    fn extra_offsets_move_into_the_screen_clock() {
        // camera + offset = screen: at offset 2 s, a camera frame at 0.5 s is due at 2.5 s
        // of screen time, not before.
        let held = camera_source_time(2.4, 2.0);
        let due = camera_source_time(2.5, 2.0);
        assert_eq!(frame_step(NextFrameTime::At(0.5), 0.0, held), FrameStep::Hold);
        assert_eq!(frame_step(NextFrameTime::At(0.5), 0.0, due), FrameStep::Commit);
        // Before the camera started, its source time clamps to its first frame.
        assert_eq!(camera_source_time(1.0, 2.0), 0.0);
    }
}
