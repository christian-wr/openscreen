//! Which camera layers a frame draws, and where, inside camera layout regions.
//!
//! Pure planning: `plan_frame` calls `camera_layers_at` and the backends draw the result. A
//! region's layers glide in from whatever was on screen before it (the default camera-1 PiP,
//! or the layers of a region that ends exactly where it starts) and glide back out to the
//! default, on the Full Camera envelope (`regions::camera_fullscreen_region_phase`): the same
//! window lengths, the same `ease_out_screen_studio` curve, measured on the screen clock. A
//! camera-1 Full Camera region that meets a layout region at a seam is a neighbour like any
//! other: camera 0 frame-filling, gliding straight into or out of the layout region's layers.

use crate::frame_geometry::webcam_shape_code;
use crate::regions::{
    ease_out_screen_studio, ScreenClock, FULLSCREEN_LEAD_OUT_WINDOW_S, REGION_SEAM_S,
    TRANSITION_WINDOW_S,
};
use crate::scene::{SceneCameraFullscreenRegion, SceneCameraLayer, SceneCameraLayoutRegion};

/// Two regions closer than this (source seconds) hand over directly, without the default.
const ADJACENT_S: f64 = REGION_SEAM_S;
/// Layers fainter than this are not drawn at all.
const MIN_OPACITY: f32 = 1e-3;
/// Cameras beyond camera 0 a compositor takes frames for (`set_extra_camera_frames`).
pub const MAX_EXTRA_CAMERAS: usize = 3;

/// One camera to draw this frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraLayerPlan {
    pub camera: usize,
    /// x, y, w, h in output fractions.
    pub dst: [f32; 4],
    /// Corner radius as a fraction of min(dst w, h) in pixels.
    pub radius_frac: f32,
    /// `webcam_shape_code` vocabulary.
    pub shape: u32,
    /// 0..1.
    pub opacity: f32,
    pub fills_frame: bool,
}

fn plan_of(layer: &SceneCameraLayer) -> CameraLayerPlan {
    let r = layer.rect;
    CameraLayerPlan {
        camera: layer.camera,
        dst: [r.x, r.y, r.width, r.height],
        radius_frac: layer.radius_frac,
        shape: webcam_shape_code(&layer.shape),
        opacity: 1.0,
        fills_frame: layer.fills_frame,
    }
}

fn lerp(a: f32, b: f32, k: f32) -> f32 {
    a + (b - a) * k
}

/// `a` turning into `b` at `k` (0 = all `a`, 1 = all `b`). A camera in both moves; a camera in
/// only one of them fades. Draw order: frame-filling layers first, then the rest, each group in
/// `b`'s order followed by what only `a` still shows.
fn blend(a: &[CameraLayerPlan], b: &[CameraLayerPlan], k: f32) -> Vec<CameraLayerPlan> {
    let k = k.clamp(0.0, 1.0);
    let mut out = Vec::with_capacity(a.len() + b.len());
    for to in b {
        out.push(match a.iter().find(|from| from.camera == to.camera) {
            Some(from) => {
                // Discrete properties switch half-way through the move.
                let flags = if k >= 0.5 { to } else { from };
                CameraLayerPlan {
                    camera: to.camera,
                    dst: std::array::from_fn(|i| lerp(from.dst[i], to.dst[i], k)),
                    radius_frac: lerp(from.radius_frac, to.radius_frac, k),
                    shape: flags.shape,
                    opacity: 1.0,
                    fills_frame: flags.fills_frame,
                }
            }
            None => CameraLayerPlan { opacity: k, ..*to },
        });
    }
    for from in a {
        if !b.iter().any(|to| to.camera == from.camera) {
            out.push(CameraLayerPlan { opacity: 1.0 - k, ..*from });
        }
    }
    out.retain(|layer| layer.opacity > MIN_OPACITY);
    // Stable: each group keeps the order built above.
    out.sort_by_key(|layer| !layer.fills_frame);
    out
}

/// Camera 0 as a Full Camera region shows it: the whole frame, square corners. Same discrete
/// shape as the default layer, so the hand-over to the default inside the region is seamless.
fn full_camera_layer(default: &CameraLayerPlan) -> CameraLayerPlan {
    CameraLayerPlan {
        camera: 0,
        dst: [0.0, 0.0, 1.0, 1.0],
        radius_frac: 0.0,
        shape: default.shape,
        opacity: 1.0,
        fills_frame: true,
    }
}

/// The layers to draw at source time `t`, in draw order.
///
/// `default_cam0`: camera 0's layer as today's plan places it (None = camera 0 not drawn). It
/// is what shows outside every region, and what a region glides from and back to.
///
/// `fullscreen`: the camera-1 Full Camera regions. One that meets a layout region at a seam
/// is that region's neighbour, with camera 0 frame-filling: the layout region glides in from
/// it, or holds to its end and the Full Camera region's lead-in glides on from its layers
/// (the Full Camera phase holds 1 on that side, `regions::camera_fullscreen_region_phase`).
///
/// Time base: copied from `camera_fullscreen_region_phase` — the region is found on SOURCE
/// time (its bounds compared to `t` as `f32`), then the windows are measured on the SCREEN
/// clock (`clock.at`), so a speed region does not stretch or squash the glide.
pub fn camera_layers_at(
    regions: &[SceneCameraLayoutRegion],
    fullscreen: &[SceneCameraFullscreenRegion],
    t: f32,
    clock: &ScreenClock,
    default_cam0: Option<CameraLayerPlan>,
) -> Vec<CameraLayerPlan> {
    let default: Vec<CameraLayerPlan> = default_cam0.into_iter().collect();
    let full_cam0: Vec<CameraLayerPlan> = default_cam0.iter().map(full_camera_layer).collect();
    // An empty (or reversed) region would match `t` at a single instant and draw its layers
    // at full strength for that sample; it is neither drawn nor anyone's neighbour.
    let non_empty = || regions.iter().enumerate().filter(|(_, r)| r.end_sec > r.start_sec);
    let full_cameras = || fullscreen.iter().filter(|r| r.end_sec > r.start_sec);
    let layers_of = |r: &SceneCameraLayoutRegion| r.layers.iter().map(plan_of).collect::<Vec<_>>();
    let Some(index) = non_empty()
        .find(|(_, r)| r.start_sec as f32 <= t && t <= r.end_sec as f32)
        .map(|(i, _)| i)
    else {
        return full_camera_lead_in(regions, fullscreen, t, clock, &full_cam0).unwrap_or(default);
    };
    let region = &regions[index];
    let others = || non_empty().filter(move |(i, _)| *i != index).map(|(_, r)| r);
    let prev = others()
        .find(|r| (r.end_sec - region.start_sec).abs() <= ADJACENT_S)
        .map(layers_of)
        .or_else(|| {
            full_cameras()
                .any(|f| (f.end_sec - region.start_sec).abs() <= ADJACENT_S)
                .then(|| full_cam0.clone())
        });
    let has_next = others().any(|r| (r.start_sec - region.end_sec).abs() <= ADJACENT_S)
        || full_cameras().any(|f| (f.start_sec - region.end_sec).abs() <= ADJACENT_S);
    let current = layers_of(region);

    let (start, end, t) = (
        clock.at(region.start_sec as f32),
        clock.at(region.end_sec as f32),
        clock.at(t),
    );
    let half = (end - start) * 0.5;
    let win_in = TRANSITION_WINDOW_S.min(half);
    let win_out = FULLSCREEN_LEAD_OUT_WINDOW_S.min(half);
    if t - start < win_in {
        let from = prev.as_deref().unwrap_or(&default);
        blend(from, &current, ease_out_screen_studio((t - start) / win_in))
    } else if !has_next && end - t < win_out {
        // With a region right after this one, the hand-over is that region's lead-in instead.
        blend(&current, &default, 1.0 - ease_out_screen_studio((end - t) / win_out))
    } else {
        blend(&[], &current, 1.0)
    }
}

/// Inside a Full Camera region that starts where a layout region ends, during its lead-in:
/// the layout region's layers gliding into camera 0 frame-filling (`full_cam0`), on the same
/// window and curve as a layout region's lead-in. None anywhere else.
fn full_camera_lead_in(
    regions: &[SceneCameraLayoutRegion],
    fullscreen: &[SceneCameraFullscreenRegion],
    t: f32,
    clock: &ScreenClock,
    full_cam0: &[CameraLayerPlan],
) -> Option<Vec<CameraLayerPlan>> {
    let full = fullscreen.iter().find(|f| {
        f.end_sec > f.start_sec && f.start_sec as f32 <= t && t <= f.end_sec as f32
    })?;
    let before = regions.iter().find(|r| {
        r.end_sec > r.start_sec && (r.end_sec - full.start_sec).abs() <= ADJACENT_S
    })?;
    let (start, end) = (clock.at(full.start_sec as f32), clock.at(full.end_sec as f32));
    let t = clock.at(t);
    let win_in = TRANSITION_WINDOW_S.min((end - start) * 0.5);
    if t - start >= win_in {
        return None;
    }
    let from: Vec<CameraLayerPlan> = before.layers.iter().map(plan_of).collect();
    Some(blend(&from, full_cam0, ease_out_screen_studio((t - start) / win_in)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::SceneRect;

    const PIP: [f32; 4] = [0.75, 0.7, 0.22, 0.22];
    const CORNER: [f32; 4] = [0.05, 0.05, 0.2, 0.2];
    const FULL: [f32; 4] = [0.0, 0.0, 1.0, 1.0];

    fn default_pip() -> Option<CameraLayerPlan> {
        Some(CameraLayerPlan {
            camera: 0,
            dst: PIP,
            radius_frac: 0.5,
            shape: 1,
            opacity: 1.0,
            fills_frame: false,
        })
    }

    fn region(start: f64, end: f64, layers: &[(usize, [f32; 4], bool)]) -> SceneCameraLayoutRegion {
        SceneCameraLayoutRegion {
            clip_index: Some(0),
            start_sec: start,
            end_sec: end,
            layers: layers
                .iter()
                .map(|&(camera, r, fills_frame)| SceneCameraLayer {
                    camera,
                    rect: SceneRect { x: r[0], y: r[1], width: r[2], height: r[3] },
                    radius_frac: if fills_frame { 0.0 } else { 0.3 },
                    shape: if fills_frame { "rectangle" } else { "rounded" }.to_string(),
                    fills_frame,
                })
                .collect(),
        }
    }

    fn at(regions: &[SceneCameraLayoutRegion], t: f32) -> Vec<CameraLayerPlan> {
        camera_layers_at(regions, &[], t, &ScreenClock::default(), default_pip())
    }

    fn layer(layers: &[CameraLayerPlan], camera: usize) -> Option<CameraLayerPlan> {
        layers.iter().copied().find(|l| l.camera == camera)
    }

    fn strictly_between(v: f32, a: f32, b: f32) -> bool {
        v > a.min(b) && v < a.max(b)
    }

    #[test]
    fn outside_every_region_only_the_default_camera_is_drawn() {
        let regions = [region(2.0, 6.0, &[(1, FULL, true)])];
        for t in [0.0, 1.9, 6.1, 9.0] {
            assert_eq!(at(&regions, t), vec![default_pip().unwrap()], "t = {t}");
        }
        assert!(camera_layers_at(&regions, &[], 1.0, &ScreenClock::default(), None).is_empty());
    }

    #[test]
    fn inside_a_region_after_the_lead_in_its_layers_are_drawn_fully() {
        let regions = [region(2.0, 6.0, &[(1, FULL, true), (0, CORNER, false)])];
        let layers = at(&regions, 4.0);
        assert_eq!(layers.len(), 2);
        assert_eq!(layers[0].camera, 1);
        assert_eq!(layers[0].dst, FULL);
        assert_eq!(layers[0].opacity, 1.0);
        assert!(layers[0].fills_frame);
        assert_eq!(layers[1].camera, 0);
        assert_eq!(layers[1].dst, CORNER);
        assert_eq!(layers[1].opacity, 1.0);
        assert_eq!(layers[1].shape, webcam_shape_code("rounded"));
        assert_eq!(layers[1].radius_frac, 0.3);
    }

    #[test]
    fn entering_a_region_glides_camera_0_and_fades_in_a_new_camera() {
        let regions = [region(2.0, 6.0, &[(1, FULL, true), (0, CORNER, false)])];
        let layers = at(&regions, 2.0 + TRANSITION_WINDOW_S / 2.0);
        let cam0 = layer(&layers, 0).expect("camera 0");
        for i in 0..4 {
            assert!(strictly_between(cam0.dst[i], PIP[i], CORNER[i]), "dst[{i}] = {}", cam0.dst[i]);
        }
        assert_eq!(cam0.opacity, 1.0);
        let cam1 = layer(&layers, 1).expect("camera 1");
        assert!(strictly_between(cam1.opacity, 0.0, 1.0), "opacity {}", cam1.opacity);
        assert_eq!(cam1.dst, FULL);
        // On the region's start the glide has not begun.
        assert_eq!(at(&regions, 2.0), vec![default_pip().unwrap()]);
    }

    #[test]
    fn leaving_a_region_returns_to_the_default() {
        let regions = [region(2.0, 6.0, &[(1, FULL, true), (0, CORNER, false)])];
        let win_out = FULLSCREEN_LEAD_OUT_WINDOW_S.min(2.0);
        let layers = at(&regions, 6.0 - win_out / 2.0);
        let cam0 = layer(&layers, 0).expect("camera 0");
        for i in 0..4 {
            assert!(strictly_between(cam0.dst[i], PIP[i], CORNER[i]), "dst[{i}] = {}", cam0.dst[i]);
        }
        let cam1 = layer(&layers, 1).expect("camera 1");
        assert!(strictly_between(cam1.opacity, 0.0, 1.0), "opacity {}", cam1.opacity);
        // On the region's end it is back to the default, exactly.
        let end = at(&regions, 6.0);
        assert_eq!(end.len(), 1);
        assert_eq!(end[0].camera, 0);
        for i in 0..4 {
            assert!((end[0].dst[i] - PIP[i]).abs() < 1e-6);
        }
    }

    #[test]
    fn adjacent_regions_glide_directly() {
        let regions = [region(2.0, 5.0, &[(1, FULL, true)]), region(5.0, 8.0, &[(2, FULL, true)])];
        // The end of A keeps A: no lead-out to the default PiP.
        let before = at(&regions, 5.0 - 0.01);
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].camera, 1);
        assert_eq!(before[0].opacity, 1.0);
        // B's lead-in hands camera 1 over to camera 2.
        let during = at(&regions, 5.0 + TRANSITION_WINDOW_S / 2.0);
        let cam1 = layer(&during, 1).expect("camera 1 fading out");
        let cam2 = layer(&during, 2).expect("camera 2 fading in");
        assert!(strictly_between(cam1.opacity, 0.0, 1.0));
        assert!(strictly_between(cam2.opacity, 0.0, 1.0));
        // Neither region has camera 0, so the default PiP never shows around the seam.
        let mut t = 4.8f32;
        while t <= 5.2 {
            assert!(layer(&at(&regions, t), 0).is_none(), "camera 0 at t = {t}");
            t += 0.01;
        }
    }

    fn full_camera(start: f64, end: f64) -> SceneCameraFullscreenRegion {
        SceneCameraFullscreenRegion {
            clip_index: Some(0),
            start_sec: start,
            end_sec: end,
            rotation: 0,
            mirror: None,
            full_frame: false,
        }
    }

    /// The plan with Full Camera regions, camera 0's default placed as `plan_frame` places it:
    /// grown from the PiP to the frame by the Full Camera progress.
    fn at_with_full(
        regions: &[SceneCameraLayoutRegion],
        fulls: &[SceneCameraFullscreenRegion],
        t: f32,
    ) -> Vec<CameraLayerPlan> {
        let clock = ScreenClock::default();
        let p = crate::regions::camera_fullscreen_progress_at(fulls, t, &clock, regions);
        let default = CameraLayerPlan {
            dst: std::array::from_fn(|i| lerp(PIP[i], FULL[i], p)),
            fills_frame: p >= 1.0,
            ..default_pip().unwrap()
        };
        camera_layers_at(regions, fulls, t, &clock, Some(default))
    }

    /// Camera 0 on the straight path between two rects: never the default PiP's geometry.
    fn on_the_path(dst: [f32; 4], a: [f32; 4], b: [f32; 4]) -> bool {
        (0..4).all(|i| dst[i] >= a[i].min(b[i]) - 1e-5 && dst[i] <= a[i].max(b[i]) + 1e-5)
    }

    #[test]
    fn full_camera_then_layout_region_glides_directly() {
        let regions = [region(5.0, 8.0, &[(1, FULL, true), (0, CORNER, false)])];
        let fulls = [full_camera(2.0, 5.0)];
        // The end of the Full Camera region keeps camera 0 on the frame: no shrink.
        let before = at_with_full(&regions, &fulls, 5.0 - 0.01);
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].camera, 0);
        assert_eq!(before[0].dst, FULL);
        assert!(before[0].fills_frame);
        // The layout region's lead-in moves camera 0 from the frame to its corner.
        let during = at_with_full(&regions, &fulls, 5.0 + TRANSITION_WINDOW_S / 2.0);
        let cam0 = layer(&during, 0).expect("camera 0");
        for i in 2..4 {
            assert!(strictly_between(cam0.dst[i], FULL[i], CORNER[i]), "dst[{i}] = {}", cam0.dst[i]);
        }
        let cam1 = layer(&during, 1).expect("camera 1 fading in");
        assert!(strictly_between(cam1.opacity, 0.0, 1.0));
        // The default PiP never shows around the seam.
        let mut t = 3.5f32;
        while t <= 5.0 + TRANSITION_WINDOW_S + 0.1 {
            let cam0 = layer(&at_with_full(&regions, &fulls, t), 0).expect("camera 0");
            assert!(on_the_path(cam0.dst, FULL, CORNER), "t = {t}: {:?}", cam0.dst);
            assert_eq!(cam0.opacity, 1.0, "t = {t}");
            t += 0.005;
        }
    }

    #[test]
    fn layout_region_then_full_camera_glides_directly() {
        let regions = [region(2.0, 5.0, &[(1, FULL, true), (0, CORNER, false)])];
        let fulls = [full_camera(5.0, 8.0)];
        // The end of the layout region keeps its layers: no lead-out to the default PiP.
        let before = at_with_full(&regions, &fulls, 5.0 - 0.01);
        assert_eq!(layer(&before, 0).expect("camera 0").dst, CORNER);
        assert_eq!(layer(&before, 1).expect("camera 1").opacity, 1.0);
        // The Full Camera lead-in takes camera 0 from its corner to the frame; camera 1 fades.
        let during = at_with_full(&regions, &fulls, 5.0 + TRANSITION_WINDOW_S / 2.0);
        let cam0 = layer(&during, 0).expect("camera 0");
        for i in 2..4 {
            assert!(strictly_between(cam0.dst[i], CORNER[i], FULL[i]), "dst[{i}] = {}", cam0.dst[i]);
        }
        let cam1 = layer(&during, 1).expect("camera 1 fading out");
        assert!(strictly_between(cam1.opacity, 0.0, 1.0));
        // After the lead-in camera 0 is the default again, which the held phase keeps full.
        let after = at_with_full(&regions, &fulls, 5.0 + TRANSITION_WINDOW_S + 0.01);
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].dst, FULL);
        let mut t = 3.5f32;
        while t <= 7.0 {
            let cam0 = layer(&at_with_full(&regions, &fulls, t), 0).expect("camera 0");
            assert!(on_the_path(cam0.dst, CORNER, FULL), "t = {t}: {:?}", cam0.dst);
            assert_eq!(cam0.opacity, 1.0, "t = {t}");
            t += 0.005;
        }
    }

    #[test]
    fn a_full_camera_region_off_the_seam_is_no_neighbour() {
        // 10 ms apart: the layout region glides from the default as before.
        let regions = [region(5.01, 8.0, &[(1, FULL, true), (0, CORNER, false)])];
        let fulls = [full_camera(2.0, 5.0)];
        assert_eq!(
            at_with_full(&regions, &fulls, 5.01 + TRANSITION_WINDOW_S / 2.0),
            at(&regions, 5.01 + TRANSITION_WINDOW_S / 2.0)
        );
        let shrinking = layer(&at_with_full(&regions, &fulls, 4.9), 0).expect("camera 0");
        assert!(shrinking.dst[2] < 1.0, "the Full Camera region leads out: {:?}", shrinking.dst);
    }

    #[test]
    fn a_short_region_halves_its_windows() {
        let regions = [region(2.0, 3.0, &[(1, FULL, true)])];
        // Both windows are 0.5 s: the middle is the only frame at full strength.
        let mid = at(&regions, 2.5);
        assert_eq!(mid.len(), 1);
        assert_eq!(mid[0].camera, 1);
        assert_eq!(mid[0].opacity, 1.0);
        for t in [2.25, 2.75] {
            let cam1 = layer(&at(&regions, t), 1).expect("camera 1");
            assert!(strictly_between(cam1.opacity, 0.0, 1.0), "t = {t}");
        }
    }

    #[test]
    fn an_empty_region_draws_nothing_of_its_own() {
        // start == end (and a reversed region) would otherwise match `t` at its one instant
        // and draw its layers at full strength for that sample.
        for regions in [
            [region(3.0, 3.0, &[(1, FULL, true)])],
            [region(3.0, 2.0, &[(1, FULL, true)])],
        ] {
            for t in [2.0, 2.5, 3.0] {
                let layers = at(&regions, t);
                assert!(layer(&layers, 1).is_none(), "t = {t}");
                assert_eq!(layers.len(), 1, "t = {t}");
                assert_eq!(layers[0].camera, 0, "t = {t}");
            }
        }
        // Nor does it count as a neighbour: the region before it still leads out.
        let regions = [region(2.0, 6.0, &[(1, FULL, true)]), region(6.0, 6.0, &[(1, FULL, true)])];
        let cam1 = layer(&at(&regions, 5.9), 1).expect("camera 1");
        assert!(strictly_between(cam1.opacity, 0.0, 1.0));
    }

    #[test]
    fn fills_frame_layers_are_drawn_first() {
        let regions = [region(2.0, 6.0, &[(0, CORNER, false), (1, FULL, true)])];
        let order: Vec<usize> = at(&regions, 4.0).iter().map(|l| l.camera).collect();
        assert_eq!(order, vec![1, 0]);
        // During the lead-in too.
        let order: Vec<usize> =
            at(&regions, 2.0 + TRANSITION_WINDOW_S / 2.0).iter().map(|l| l.camera).collect();
        assert_eq!(order, vec![1, 0]);
    }
}
