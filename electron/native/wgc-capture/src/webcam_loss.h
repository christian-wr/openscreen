#pragma once

#include <Windows.h>

#include <cstdint>
#include <string>

/** How long reads may keep failing, back to back, before the camera counts as gone. */
constexpr int64_t kWebcamLossFailureRunMs = 1000;

/**
 * Does this read result mean the camera has left the take?
 *
 * Media Foundation reports an unplugged camera as
 * MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED on every following ReadSample, and a
 * camera whose driver gave up as MF_E_HW_MFT_FAILED_START_STREAMING; both are
 * final. End of stream while the take is still running is the same thing said
 * differently. Any other failure is forgiven once -- a camera can drop a read --
 * but not for `kWebcamLossFailureRunMs` in a row: a reader that fails that long
 * delivers nothing, and treating it as alive is what froze a file on its last
 * picture for the rest of the take.
 *
 * `consecutiveFailureMs` is the time since the first failure of the current
 * run; a successful read ends the run. Ignored when `hr` succeeded.
 */
bool isWebcamLossResult(HRESULT hr, bool endOfStream, int64_t consecutiveFailureMs);

/**
 * The one line both capture backends print when a camera leaves the take.
 *
 * `hr` is the read result that decided it, or the DirectShow event code when
 * the graph reported the loss.
 */
void reportWebcamLost(const std::wstring& deviceName, HRESULT hr);
