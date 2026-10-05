#include "webcam_loss.h"

#include <mferror.h>

#include <cstdio>

namespace {
int failures = 0;
void expect(bool ok, const char* label) {
    if (!ok) {
        std::printf("FAIL %s\n", label);
        ++failures;
    }
}
}  // namespace

int main() {
    // The code the on-site test logged after the C920 was unplugged.
    expect(isWebcamLossResult(MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED, false, 0),
           "device invalidated: lost on the first read");
    expect(isWebcamLossResult(MF_E_HW_MFT_FAILED_START_STREAMING, false, 0),
           "hardware failed to start streaming: lost");
    expect(isWebcamLossResult(S_OK, true, 0), "end of stream during the take: lost");

    expect(!isWebcamLossResult(E_FAIL, false, 0), "one other failure: not lost");
    expect(!isWebcamLossResult(E_FAIL, false, kWebcamLossFailureRunMs - 1),
           "other failures for just under a second: not lost");
    expect(isWebcamLossResult(E_FAIL, false, kWebcamLossFailureRunMs),
           "other failures for a second: lost");
    expect(isWebcamLossResult(MF_E_NOTACCEPTING, false, 5000), "any failure code, long run: lost");

    expect(!isWebcamLossResult(S_OK, false, 0), "S_OK: not lost");
    expect(!isWebcamLossResult(S_OK, false, 5000), "S_OK ends a run of failures: not lost");

    if (failures == 0) {
        std::printf("webcam_loss_test: all assertions passed\n");
        return 0;
    }
    std::printf("webcam_loss_test: %d failure(s)\n", failures);
    return 1;
}
