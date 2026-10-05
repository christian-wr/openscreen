#pragma once

#include <cstddef>
#include <string>
#include <vector>

struct WebcamConfig {
    std::string deviceId, deviceName, directShowClsid, outputPath;
    int width = 0, height = 0, fps = 0;
};

constexpr size_t kMaxWebcams = 4;

// The cameras to record, in order. Reads the `webcams` list when present and
// non-empty; otherwise the legacy single-camera fields (webcamEnabled, webcamDeviceId,
// webcamDeviceName, webcamDirectShowClsid, webcamWidth/Height/Fps, webcamPath).
std::vector<WebcamConfig> parseWebcamConfigs(const std::string& json);
