#include "webcam_loss.h"

#include <mferror.h>

#include <iostream>

bool isWebcamLossResult(HRESULT hr, bool endOfStream, int64_t consecutiveFailureMs) {
    if (SUCCEEDED(hr)) {
        return endOfStream;
    }
    if (hr == MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED || hr == MF_E_HW_MFT_FAILED_START_STREAMING) {
        return true;
    }
    return consecutiveFailureMs >= kWebcamLossFailureRunMs;
}

void reportWebcamLost(const std::wstring& deviceName, HRESULT hr) {
    std::string name;
    const int size = WideCharToMultiByte(
        CP_UTF8, 0, deviceName.data(), static_cast<int>(deviceName.size()), nullptr, 0, nullptr, nullptr);
    if (size > 0) {
        name.resize(static_cast<size_t>(size));
        WideCharToMultiByte(
            CP_UTF8, 0, deviceName.data(), static_cast<int>(deviceName.size()), name.data(), size, nullptr, nullptr);
    }
    std::cerr << "WARNING: Webcam lost during the take: " << name << " hr=0x" << std::hex
              << static_cast<unsigned long>(hr) << std::dec << std::endl;
}
