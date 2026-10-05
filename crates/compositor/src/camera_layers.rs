//! Which camera layers a frame draws, and where, inside camera layout regions.
//!
//! Pure planning: `plan_frame` calls `camera_layers_at` and the backends draw the result. A
//! region's layers glide in from whatever was on screen before it (the default camera-1 PiP,
//! or the layers of a region that ends exactly where it starts) and glide back out to the
//! default, on the Full Camera envelope (`regions::camera_fullscreen_region_phase`): the same
//! window lengths, the same `ease_out_screen_studio` curve, measured on the screen clock.

use crate::frame_geometry::webcam_shape_code;
use crate::regions::{
    ease_out_screen_studio, ScreenClock, FULLSCREEN_LEAD_OUT_WINDOW_S, TRANSITION_WINDOW_S,
};
use crate::scene::{SceneCameraLayer, SceneCameraLayoutRegion};

/// Two regions closer than this (source seconds) hand over directly, without the default.
const ADJACENT_S: f64 = 0.001;
/// Layers fainter than this are not drawn at all.
const MIN_OPACITY: f32 = 1e-3;

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

/// The layers to draw at source time `t`, in draw order.
///
/// `default_cam0`: camera 0's layer as today's plan places it (None = camera 0 not drawn). It
/// is what shows outside every region, and what a region glides from and back to.
///
/// Time base: copied from `camera_fullscreen_region_phase` — the region is found on SOURCE
/// time (its bounds compared to `t` as `f32`), then the windows are measured on the SCREEN
/// clock (`clock.at`), so a speed region does not stretch or squash the glide.
pub fn camera_layers_at(
    regions: &[SceneCameraLayoutRegion],
    t: f32,
    clock: &ScreenClock,
    default_cam0: Option<CameraLayerPlan>,
) -> Vec<CameraLayerPlan> {
    let default: Vec<CameraLayerPlan> = default_cam0.into_iter().collect();
    // An empty (or reversed) region would match `t` at a single instant and draw its layers
    // at full strength for that sample; it is neither drawn nor anyone's neighbour.
    let non_empty = || regions.iter().enumerate().filter(|(_, r)| r.end_sec > r.start_sec);
    let Some(index) = non_empty()
        .find(|(_, r)| r.start_sec as f32 <= t && t <= r.end_sec as f32)
        .map(|(i, _)| i)
    else {
        return default;
    };
    let region = &regions[index];
    let layers_of = |r: &SceneCameraLayoutRegion| r.layers.iter().map(plan_of).collect::<Vec<_>>();
    let others = || non_empty().filter(move |(i, _)| *i != index).map(|(_, r)| r);
    let prev = others()
        .find(|r| (r.end_sec - region.start_sec).abs() <= ADJACENT_S)
        .map(layers_of);
    let has_next = others().any(|r| (r.start_sec - region.end_sec).abs() <= ADJACENT_S);
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
        camera_layers_at(regions, t, &ScreenClock::default(), default_pip())
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
        assert!(camera_layers_at(&regions, 1.0, &ScreenClock::default(), None).is_empty());
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
