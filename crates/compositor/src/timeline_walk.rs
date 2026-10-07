//! La marche de timeline partagée par tous les exports composités.
//!
//! Ce module ne contient QUE du code portable : il ne parle qu'au `Decoder` et au
//! `Compositor` ré-exportés par `lib.rs` (`crate::pipeline`, `crate::compositor`), donc
//! D3D11VA sur Windows et VideoToolbox sur macOS sans une seule ligne de `cfg`.
//!
//! Il vivait dans `pipeline_windows.rs`, ce qui n'était pas tenable une fois le port
//! macOS entré : `gif_export.rs` importe `crate::pipeline::walk_composited_timeline`, et
//! `crate::pipeline` pointe sur `pipeline_macos` sur un Mac — l'export GIF ne compilait
//! donc pas du tout côté macOS. Les deux réponses possibles étaient recopier ~170 lignes
//! dans `pipeline_macos.rs`, ou les sortir ici. La duplication est précisément ce que la
//! doc de `walk_composited_timeline` interdit — « a GIF driven by its own loop is how the
//! slow-motion truncation bug happened » — et l'argument vaut autant entre deux
//! plateformes qu'entre deux formats de sortie.

use crate::compositor::Compositor;
use crate::config::Cfg;
use crate::cursor::CursorTrack;
use crate::d3d::Gpu;
use crate::extra_cameras::{
    camera_source_time, cameras_in_regions, extra_camera_active, extra_camera_keys, open_once,
    step_extra_camera,
};
use crate::ffi::AVFrame;
use crate::frame_geometry::webcam_is_real;
use crate::pipeline::{ClipSource, Decoder};
use crate::regions::{speed_segments_for_window, SpeedSegment};
use crate::scene::{Scene, SceneCameraLayoutRegion};
use anyhow::Result;
use std::collections::{HashMap, HashSet};

/// Ce que le décodeur sait de la PROCHAINE frame, sans l'adopter.
///
/// Un simple `Option<f64>` ne suffisait pas : il confondait « pts inexploitable » et
/// « pts = 0 ». `peek_next_time_sec` renvoyait `0.0` quand `best_effort_timestamp` vaut
/// `i64::MIN` (ou que la time_base est nulle), et `0.0` satisfait TOUJOURS la condition
/// d'adoption — un flux sans pts fiable se faisait donc vider frame après frame jusqu'à
/// l'EOF, exactement le défaut que la sémantique de hold est censée corriger, en pire.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum NextFrameTime {
    /// pts exploitable de la frame en attente, en secondes.
    At(f64),
    /// Une frame attend, mais son pts est inexploitable : impossible de dire si elle est
    /// due. Le seul repli honnête est d'avancer d'UNE frame puis de rendre la main —
    /// c'est le comportement d'avant la sémantique de hold, restreint au flux cassé qui
    /// le mérite au lieu d'être la règle générale.
    Unknown,
    /// Plus aucune frame à décoder.
    Eof,
}

/// Ce que la boucle d'avance doit faire de la frame en attente.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum FrameStep {
    /// Adopter la frame, puis continuer à chercher.
    Commit,
    /// Adopter la frame puis s'arrêter (cas `Unknown`, cf. ci-dessus).
    CommitAndStop,
    /// Ne rien adopter : on tient la frame courante.
    Hold,
}

/// Décision pure de la sémantique de hold — extraite pour être testable sans ffmpeg ni
/// fichier, parce que c'est ici que vivent les cas limites (EOF, pts inconnu, et la
/// frontière exacte « due » vs « pas encore due »).
///
/// `offset_sec` remet le pts dans le référentiel de la cible (`webcam + offset = écran`).
pub(crate) fn frame_step(next: NextFrameTime, offset_sec: f64, target_sec: f64) -> FrameStep {
    match next {
        // Plus rien à décoder : on tient la dernière frame connue. C'est ce qui permet à
        // un clip dont la dernière frame RÉELLE précède la fin déclarée d'occuper quand
        // même toute sa fenêtre — cf. `walk_composited_timeline`.
        NextFrameTime::Eof => FrameStep::Hold,
        NextFrameTime::Unknown => FrameStep::CommitAndStop,
        // `>` et non `>=` : une frame dont le pts vaut EXACTEMENT la cible est due
        // (« la dernière frame dont le pts est ≤ t »).
        NextFrameTime::At(t) if t + offset_sec > target_sec => FrameStep::Hold,
        NextFrameTime::At(_) => FrameStep::Commit,
    }
}

/// Avance un décodeur vers `target_source_time`, sémantique de "hold" : à l'instant t on
/// affiche la DERNIÈRE frame dont le pts est ≤ t, jamais une frame dont le pts est encore à
/// venir. `timeline_offset_sec` remet les pts webcam dans le référentiel écran
/// (`webcam + offset = screen`) : chaque source garde ainsi sa cadence propre au lieu
/// d'être consommée 1:1 avec l'autre.
///
/// BUG corrigé : l'ancienne version avançait tant que `cur_time_sec() < target`, un pas de
/// `next()` à la fois, et s'arrêtait dès que la frame COURANTE dépassait la cible — mais
/// `next()` saute à la prochaine frame RÉELLEMENT capturée, qui peut être très en avance
/// sur `target` quand la source a un trou (ex. ScreenCaptureKit qui ne livre rien tant que
/// l'écran ne change pas). Un seul `next()` pouvait alors faire passer le décodeur d'un pts
/// proche de la cible à un pts bien après elle, et la condition d'arrêt considérait ça comme
/// "atteint" — la frame FUTURE se retrouvait affichée bien avant son heure. Ici, `next()`
/// n'est plus appelé à l'aveugle : on regarde d'abord le pts de la frame suivante
/// (`peek_next_time_sec`, décodée dans un buffer séparé) et on ne l'adopte
/// (`commit_peek`) que si elle est réellement due ; sinon on continue de tenir la frame
/// courante, aussi longtemps qu'il le faut.
///
/// CHANGEMENT DE COMPORTEMENT À L'EXPORT, délibéré : à l'EOF cette fonction renvoie
/// désormais `true` (on tient la dernière frame) là où elle renvoyait `false`, ce qui
/// coupait la boucle du clip (`break 'clip_frames`). Un clip dont la fenêtre déclarée
/// dépasse le dernier pts réel — dernière frame légèrement avant `source_end_sec`, ou
/// piste webcam plus courte que l'écran — ne se termine donc plus en avance : il occupe
/// toute sa fenêtre en tenant sa dernière image. C'est ce que l'audio suppose déjà :
/// `on_clip_end` reçoit le nombre de frames du clip et l'audio est étiré sur la durée
/// DÉCLARÉE (`stretch_clip_pcm_by_speed`), donc une vidéo qui s'arrêtait tôt décalait la
/// jonction audio/vidéo du clip suivant. La contrepartie assumée : une source réellement
/// tronquée produit maintenant une image figée jusqu'au bout de sa fenêtre au lieu de
/// s'arrêter net.
pub(crate) unsafe fn advance_decoder_to(
    decoder: &mut Decoder,
    target_source_time: f64,
    timeline_offset_sec: f64,
) -> Result<bool> {
    if decoder.cur_frame().is_null() {
        return Ok(false);
    }
    loop {
        let next = decoder.peek_next_time_sec()?;
        match frame_step(next, timeline_offset_sec, target_source_time) {
            FrameStep::Hold => return Ok(true),
            // La frame adoptée devient la frame courante : si la présentation n'a rien
            // produit, la boucle n'a plus d'invariant (elle tournerait sur une frame
            // nulle jusqu'à l'EOF) — on rend la main comme le faisait le garde d'entrée.
            FrameStep::Commit => {
                if decoder.commit_peek()?.is_null() {
                    return Ok(false);
                }
            }
            FrameStep::CommitAndStop => {
                return Ok(!decoder.commit_peek()?.is_null());
            }
        }
    }
}

/// The format-agnostic half of a multiclip export: clip iteration, decoder
/// reuse, availability clamping, per-clip scene windowing, keyframe seeks,
/// cursor binding, speed segments, and — the part that matters — advancing the
/// decoders by OUTPUT time rather than by source frames.
///
/// MP4 and GIF differ only in what they do with a composed frame (hardware NV12
/// encode vs CPU readback + palette quantize), so that is all they supply here.
/// Sharing this walk is what keeps "which source frame belongs at output frame
/// N" defined exactly once: a GIF driven by its own loop is how the slow-motion
/// truncation bug happened.
///
/// The extra cameras (k >= 1) a clip's layout regions show are opened once per path into
/// `extra_decs`, decoded only near those regions, and handed to the compositor with
/// `set_extra_camera_frames`. Unlike camera 0 they never shorten a clip, and a file that will
/// not open (or stops decoding) is skipped with a warning for the rest of the export.
///
/// `on_frame` runs after `compose_frame` with the running output index;
/// `on_clip_end` runs once per clip with its clamped source window, the frames
/// it produced, and the speed segments used (MP4 needs those for audio).
/// Runs its closure when dropped, so on every exit path of a scope, early `?` returns
/// included.
struct OnExit<F: FnMut()>(F);

impl<F: FnMut()> Drop for OnExit<F> {
    fn drop(&mut self) {
        (self.0)();
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) unsafe fn walk_composited_timeline(
    clips: &[ClipSource],
    gpu: &Gpu,
    comp: &Compositor,
    cfg: &Cfg,
    out_fps: i32,
    scene: &Option<Scene>,
    screen_decs: &mut HashMap<String, Decoder>,
    webcam_decs: &mut HashMap<String, Decoder>,
    extra_decs: &mut HashMap<String, Decoder>,
    on_frame: &mut dyn FnMut(u64) -> Result<()>,
    on_clip_end: &mut dyn FnMut(usize, f64, u64, &[SpeedSegment]) -> Result<()>,
) -> Result<u64> {
    // La piste se charge même curseur MASQUÉ : le focus auto des zooms la suit, comme en preview
    // (qui la charge toujours). Sans elle, un zoom auto suivait en preview et restait figé à
    // l'export. Ce qui ne doit rien voir d'un curseur masqué a sa propre porte sur `cursor.show` :
    // le dessin (`cursor_alpha`), la parallaxe, l'impact du clic et l'orbite en focus auto.
    let cursor_enabled = scene.is_some();
    let cursor_smoothing = scene.as_ref().map(|s| s.cursor.smoothing).unwrap_or(0.0);
    let mut cursor_tracks: HashMap<String, CursorTrack> = HashMap::new();
    let mut cursor_active_path: Option<String> = None;

    let mut frames: u64 = 0;
    let mut unreadable_extras: HashSet<String> = HashSet::new();
    // The extra decoders outlive this call in the caller's map, but the compositor must not
    // keep pointers into their frames once the walk is over — also when it fails half-way
    // (a decode or encode error returns early through `?`).
    let _forget_extra_frames = OnExit(|| {
        // SAFETY: an empty list only resets the compositor's slots; no frame is read.
        unsafe { comp.set_extra_camera_frames(&[]) }
    });

    // L'export doit être reproductible : deux rendus du même projet, les mêmes pixels. Cette
    // boucle avance aussi vite que la machine décode, sans rapport avec le temps réel, alors que
    // la segmentation est cadencée à l'horloge et calculée sur un worker — deux choix faits pour
    // la preview, et qui deviennent ici des bugs : le nombre de frames couvertes par un masque
    // suivrait la charge machine, et les premières frames sortiraient AVANT le premier masque,
    // donc avec le vrai arrière-plan de la webcam gravé dans le fichier.
    comp.set_segmentation_deterministic(true);

    for (clip_index, clip) in clips.iter().enumerate() {
        // Le preset de layout est GLOBAL (un seul panneau pour toute la timeline) mais la
        // caméra est PAR CLIP : un projet mélange sans problème un enregistrement avec webcam
        // et un import qui n'en a pas. Le preset ne doit donc s'appliquer qu'aux clips qui ont
        // vraiment une caméra — sinon la boîte PiP est dessinée avec, derrière, le décodeur de
        // repli, c'est-à-dire l'écran lui-même recopié dans son propre coin (issue #248).
        // La preview vive fait exactement ça dans `live.rs` ; c'est ici l'équivalent export.
        // Source webcam, clé de cache et dessin de la PiP sont décidés ENSEMBLE, sinon
        // ils divergent :
        //
        //  - Un clip SANS caméra arrive avec un chemin webcam vide, que `Decoder::open`
        //    refuse. Le décodeur n'existe que parce que `compose_frame` échantillonne
        //    deux flux inconditionnellement, donc on lui redonne l'écran (même repli que
        //    `live.rs::open_and_seek_clip`) et la PiP n'est pas dessinée. Sans ça,
        //    exporter un projet sans caméra échouerait net — le cas le plus courant
        //    (issue #348).
        //  - La clé DOIT être le fichier réellement ouvert. Tous les clips sans caméra
        //    portent le même chemin vide : indexer dessus faisait que le deuxième
        //    récupérait le décodeur du premier, donc l'écran d'un AUTRE clip. Pas
        //    anodin même sans PiP, `webcam_available_duration` plus bas borne
        //    `source_end_sec` — un clip de 60s derrière un clip de 41s finissait à 41s.
        //  - Un chemin NON vide qui refuse de s'ouvrir n'est pas un repli : c'est une
        //    caméra que le document réclame et qu'on ne peut pas fournir. L'erreur
        //    remonte, comme avant l'ajout du repli. La rattraper par l'écran donnerait
        //    exactement #265 — `webcam_is_real` reste vrai pour ce chemin, donc l'écran
        //    serait recopié dans sa propre vignette.
        let has_camera = webcam_is_real(&clip.webcam, &clip.screen);
        comp.set_has_webcam(has_camera);
        let webcam_key = if has_camera { &clip.webcam } else { &clip.screen };
        if !screen_decs.contains_key(&clip.screen) {
            screen_decs.insert(clip.screen.clone(), Decoder::open_for_export(&clip.screen, gpu)?);
        }
        if !webcam_decs.contains_key(webcam_key) {
            webcam_decs.insert(webcam_key.clone(), Decoder::open_for_export(webcam_key, gpu)?);
        }
        let sdec = screen_decs.get_mut(&clip.screen).unwrap();
        let wdec = webcam_decs.get_mut(webcam_key).unwrap();

        let screen_available_duration = sdec.available_duration_sec();
        let webcam_available_duration = wdec.available_duration_sec();
        if screen_available_duration.is_none() || webcam_available_duration.is_none() {
            eprintln!(
                "[pipeline] warning: clip #{}: durée de flux indéterminée (screen={}, webcam={}); la borne demandée {:.3}s ne peut pas être entièrement validée",
                clip_index,
                screen_available_duration
                    .map(|v| format!("{v:.3}s"))
                    .unwrap_or_else(|| "inconnue".to_string()),
                webcam_available_duration
                    .map(|v| format!("{v:.3}s"))
                    .unwrap_or_else(|| "inconnue".to_string()),
                clip.source_end_sec,
            );
        }
        let source_end_sec = available_clip_end(
            clip.source_end_sec,
            screen_available_duration,
            webcam_available_duration,
            clip.webcam_offset_sec,
        );
        if source_end_sec + 1e-6 < clip.source_end_sec {
            eprintln!(
                "[pipeline] warning: clip #{} raccourci de {:.3}s (fin demandée {:.3}s, fin disponible {:.3}s; screen=\"{}\", webcam=\"{}\")",
                clip_index,
                clip.source_end_sec - source_end_sec,
                clip.source_end_sec,
                source_end_sec,
                clip.screen,
                clip.webcam,
            );
        }
        if source_end_sec <= clip.source_start_sec {
            continue;
        }

        let clip_scene = scene.as_ref().map(|base_scene| {
            base_scene.for_clip_window(clip_index, clip.source_start_sec, source_end_sec)
        });
        let speed_segments = speed_segments_for_window(
            clip_scene
                .as_ref()
                .map(|s| s.speed_regions.as_slice())
                .unwrap_or(&[]),
            clip.source_start_sec,
            source_end_sec,
            out_fps as f64,
        );
        // Only the extra cameras this clip's own regions show, and only those it has a file
        // for. `None` slots stay null in `set_extra_camera_frames`.
        let camera_regions = clip_scene
            .as_ref()
            .map(|s| s.camera_layout_regions.clone())
            .unwrap_or_default();
        let mut extras: Vec<Option<ExportExtraCamera>> =
            extra_camera_keys(&cameras_in_regions(&camera_regions), &clip.additional_cameras)
                .into_iter()
                .map(|key| {
                    let key = key?;
                    open_once(extra_decs, &mut unreadable_extras, &key.path, |path| {
                        Decoder::open_for_export(path, gpu)
                    })
                    .then_some(ExportExtraCamera {
                        path: key.path,
                        offset_sec: key.offset_sec,
                        ended_at: None,
                    })
                })
                .collect();
        if clip_scene.is_some() {
            comp.set_scene(clip_scene);
        }

        // un seul seek keyframe, puis chaque décodeur avance selon son propre pts jusqu'aux
        // temps source demandés par les spans de vitesse.
        if sdec.seek_to(clip.source_start_sec)?.is_null() {
            continue; // clip vide / au-delà de la source
        }
        if wdec
            .seek_to((clip.source_start_sec - clip.webcam_offset_sec).max(0.0))?
            .is_null()
        {
            continue;
        }

        if cursor_enabled {
            if !cursor_tracks.contains_key(&clip.screen) {
                let path = format!("{}.cursor.json", clip.screen);
                if let Ok(raw) = CursorTrack::load(&path, 0.0, 24.0 * 3600.0) {
                    cursor_tracks.insert(clip.screen.clone(), raw.smoothed(cursor_smoothing));
                }
                // absente/illisible → pas d'entrée : ce clip s'exporte sans curseur (visible,
                // pas masqué en un curseur fantôme d'un autre clip).
            }
            if cursor_active_path.as_deref() != Some(clip.screen.as_str()) {
                if let Some(track) = cursor_tracks.get(&clip.screen) {
                    comp.set_cursor(track.clone());
                    cursor_active_path = Some(clip.screen.clone());
                } else {
                    comp.clear_cursor();
                    comp.set_cursor_time(None);
                    cursor_active_path = None;
                }
            }
        }

        let frames_before_clip = frames;
        'clip_frames: for segment in &speed_segments {
            for segment_frame in 0..segment.frame_count {
                let target_source_time =
                    segment.start_sec + segment_frame as f64 * segment.speed / out_fps as f64;
                {
                    let _p = crate::export_probe::scope(crate::export_probe::Stage::DecodeScreen);
                    if !advance_decoder_to(sdec, target_source_time, 0.0)? {
                        break 'clip_frames;
                    }
                }
                {
                    let _p = crate::export_probe::scope(crate::export_probe::Stage::DecodeWebcam);
                    if !advance_decoder_to(wdec, target_source_time, clip.webcam_offset_sec)? {
                        break 'clip_frames;
                    }
                }
                let sf = sdec.cur_frame();
                let wf = wdec.cur_frame();
                if sf.is_null() || wf.is_null() {
                    break 'clip_frames;
                }

                let (extra_frames, closed) = {
                    let _p = crate::export_probe::scope(crate::export_probe::Stage::DecodeWebcam);
                    step_extra_cameras(
                        &mut extras,
                        extra_decs,
                        &mut unreadable_extras,
                        &camera_regions,
                        target_source_time,
                    )
                };
                if closed {
                    // A dropped decoder's textures may still sit in the SRV cache; a later
                    // decoder could reuse their addresses (same contract as the preview's
                    // `hand_extra_frames`).
                    comp.clear_srv_cache();
                }
                comp.set_extra_camera_frames(&extra_frames);

                comp.set_timeline_time(Some(target_source_time as f32));
                // Le temps de SORTIE, lui, ne saute ni aux coupes ni aux clips. Même
                // arithmétique (f64 puis f32) que `ProgrammeClock::at` côté preview.
                comp.set_programme_time(Some((frames as f64 / out_fps as f64) as f32));
                if cursor_enabled && cursor_active_path.is_some() {
                    comp.set_cursor_time(Some(target_source_time as f32));
                }
                {
                    let _p = crate::export_probe::scope(crate::export_probe::Stage::Compose);
                    comp.compose_frame(sf, wf, frames as f32, cfg)?;
                }

                on_frame(frames)?;
                frames += 1;
            }
        }

        on_clip_end(
            clip_index,
            source_end_sec,
            frames - frames_before_clip,
            &speed_segments,
        )?;
    }

    comp.set_cursor_time(None);
    comp.set_timeline_time(None);
    comp.set_programme_time(None);
    // Le compositeur est réutilisé par la preview après un export : lui rendre sa cadence.
    comp.set_segmentation_deterministic(false);
    Ok(frames)
}

/// The screen-time end of a clip: the requested end, clamped to what the screen and camera 0
/// can deliver. Clip bounds are in screen time, so camera 0's duration is moved by the same
/// offset as its seek (`webcam_time = screen_time - offset`). The extra cameras do not enter
/// here: one that ends early only loses its layer, it never shortens the clip.
fn available_clip_end(
    requested_end_sec: f64,
    screen_duration: Option<f64>,
    webcam_duration: Option<f64>,
    webcam_offset_sec: f64,
) -> f64 {
    let mut end = requested_end_sec;
    if let Some(duration) = screen_duration {
        end = end.min(duration);
    }
    if let Some(duration) = webcam_duration {
        end = end.min(duration + webcam_offset_sec);
    }
    end
}

/// An extra camera of the clip being exported; its decoder lives in `extra_decs` under `path`.
struct ExportExtraCamera {
    path: String,
    offset_sec: f64,
    /// See `step_extra_camera`.
    ended_at: Option<f64>,
}

/// The frames for `set_extra_camera_frames` at screen source time `t`: each camera that is
/// near one of its regions steps toward its own source time, the others give null. A camera
/// that stops decoding is dropped with a warning and not reopened for the rest of the export;
/// the `bool` says one was dropped, so the caller clears the compositor's texture cache.
unsafe fn step_extra_cameras(
    extras: &mut [Option<ExportExtraCamera>],
    extra_decs: &mut HashMap<String, Decoder>,
    unreadable: &mut HashSet<String>,
    regions: &[SceneCameraLayoutRegion],
    t: f64,
) -> (Vec<*const AVFrame>, bool) {
    let mut closed = false;
    let mut frames = Vec::with_capacity(extras.len());
    for (k, slot) in extras.iter_mut().enumerate() {
        let camera = k + 1;
        let mut frame: *const AVFrame = std::ptr::null();
        if let Some(cam) = slot.as_mut().filter(|_| extra_camera_active(regions, camera, t)) {
            if let Some(dec) = extra_decs.get_mut(&cam.path) {
                let target = camera_source_time(t, cam.offset_sec);
                match step_extra_camera(dec, &mut cam.ended_at, target) {
                    Ok(f) => frame = f,
                    Err(e) => {
                        eprintln!(
                            "WARNING: extra camera {camera} stopped decoding ({}): {e:#}. Its layer will not be drawn.",
                            cam.path
                        );
                        extra_decs.remove(&cam.path);
                        unreadable.insert(cam.path.clone());
                        *slot = None;
                        closed = true;
                    }
                }
            }
        }
        frames.push(frame);
    }
    (frames, closed)
}

#[cfg(test)]
mod tests {
    use super::{available_clip_end, frame_step, FrameStep, NextFrameTime, OnExit};

    /// The guard that forgets the extra camera frames runs on an early `?` return as well as
    /// at the end of the walk.
    #[test]
    fn the_exit_guard_runs_on_every_exit_path() {
        fn walk(fail: bool, ran: &std::cell::Cell<u32>) -> anyhow::Result<()> {
            let _guard = OnExit(|| ran.set(ran.get() + 1));
            if fail {
                Err(anyhow::anyhow!("decode error"))?;
            }
            Ok(())
        }
        let ran = std::cell::Cell::new(0);
        assert!(walk(true, &ran).is_err());
        assert_eq!(ran.get(), 1, "early return");
        assert!(walk(false, &ran).is_ok());
        assert_eq!(ran.get(), 2, "normal end");
    }

    #[test]
    fn a_short_extra_camera_does_not_shorten_the_clip() {
        // Screen 60 s, camera 0 50 s at offset 2 s: the clip ends where camera 0 does.
        assert_eq!(available_clip_end(60.0, Some(60.0), Some(50.0), 2.0), 52.0);
        // A 10 s extra camera in the same clip changes nothing: only the screen and camera 0
        // bound the clip, the extra camera's layer just disappears past its end.
        assert_eq!(available_clip_end(30.0, Some(60.0), Some(50.0), 2.0), 30.0);
        assert_eq!(available_clip_end(30.0, None, None, 0.0), 30.0);
    }

    /// La cadence de lecture, en une phrase : à 24 fps, une seconde réelle doit adopter 24
    /// frames et pas une de plus. Le bug d'origine (un pas fixe de 1/60 s, une frame par
    /// pas) en consommait 60, soit 2,5× trop vite — c'est ce que ce test verrouille.
    fn frames_committed_over(fps: f64, window_sec: f64) -> usize {
        let mut committed = 0usize;
        // La frame 0 est déjà la frame courante : on compte ce qui est ADOPTÉ ensuite.
        // Le pts est recalculé depuis un index entier plutôt qu'accumulé, sinon la dérive
        // flottante fausse le compte au bout de quelques dizaines de frames.
        let mut index = 1u64;
        // Une cible qui avance au temps réel, échantillonnée à 60 Hz comme le thread de rendu.
        let ticks = (window_sec * 60.0).round() as usize;
        for tick in 1..=ticks {
            let target = tick as f64 / 60.0;
            loop {
                let pts = index as f64 / fps;
                match frame_step(NextFrameTime::At(pts), 0.0, target) {
                    FrameStep::Commit => {
                        committed += 1;
                        index += 1;
                    }
                    _ => break,
                }
            }
        }
        committed
    }

    #[test]
    fn plays_a_24fps_source_at_24_frames_per_second() {
        assert_eq!(frames_committed_over(24.0, 1.0), 24);
        assert_eq!(frames_committed_over(24.0, 2.0), 48);
    }

    #[test]
    fn plays_a_60fps_source_at_60_frames_per_second() {
        // Le cas qui tombait juste par hasard avant le correctif.
        assert_eq!(frames_committed_over(60.0, 1.0), 60);
    }

    #[test]
    fn plays_a_30fps_source_at_30_frames_per_second() {
        assert_eq!(frames_committed_over(30.0, 1.0), 30);
    }

    #[test]
    fn holds_a_frame_that_is_not_due_yet() {
        assert_eq!(frame_step(NextFrameTime::At(0.5), 0.0, 0.4), FrameStep::Hold);
    }

    #[test]
    fn adopts_a_frame_whose_pts_is_exactly_the_target() {
        // « la DERNIÈRE frame dont le pts est ≤ t » : l'égalité est due.
        assert_eq!(frame_step(NextFrameTime::At(0.4), 0.0, 0.4), FrameStep::Commit);
    }

    #[test]
    fn a_sparse_source_holds_across_its_gap() {
        // ScreenCaptureKit ne livre rien tant que l'écran ne bouge pas : la frame suivante
        // peut être 10 s plus loin. Elle ne doit surtout pas être adoptée à la seconde 1.
        assert_eq!(frame_step(NextFrameTime::At(10.0), 0.0, 1.0), FrameStep::Hold);
        assert_eq!(frame_step(NextFrameTime::At(10.0), 0.0, 10.0), FrameStep::Commit);
    }

    #[test]
    fn offset_moves_the_webcam_into_the_screen_clock() {
        // webcam + offset = écran : à offset 2 s, une frame webcam à 0.5 s vaut 2.5 s écran.
        assert_eq!(frame_step(NextFrameTime::At(0.5), 2.0, 2.4), FrameStep::Hold);
        assert_eq!(frame_step(NextFrameTime::At(0.5), 2.0, 2.5), FrameStep::Commit);
    }

    #[test]
    fn eof_holds_the_last_frame_instead_of_ending_the_clip() {
        // Le changement de comportement à l'export, verrouillé : un clip dont la fenêtre
        // déclarée dépasse le dernier pts réel occupe toute sa fenêtre en tenant sa
        // dernière image, au lieu de s'arrêter net et de décaler l'audio du clip suivant.
        assert_eq!(frame_step(NextFrameTime::Eof, 0.0, 1_000.0), FrameStep::Hold);
    }

    #[test]
    fn an_unusable_pts_advances_exactly_one_frame() {
        // Régression : `peek_next_time_sec` renvoyait `0.0` pour un pts inexploitable, et
        // `0.0` est toujours ≤ à la cible — le flux se vidait jusqu'à l'EOF d'un seul coup.
        assert_eq!(frame_step(NextFrameTime::Unknown, 0.0, 0.0), FrameStep::CommitAndStop);
        assert_eq!(
            frame_step(NextFrameTime::Unknown, 0.0, 1_000.0),
            FrameStep::CommitAndStop
        );
    }
}
