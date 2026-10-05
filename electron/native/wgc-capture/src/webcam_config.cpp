#include "webcam_config.h"

#include "json_fields.h"

#include <utility>

namespace {

// The find* helpers search the whole document, so each array entry is sliced
// out first to keep its fields from being confused with the top-level ones.
std::vector<std::string> splitTopLevelObjects(const std::string& json, const std::string& arrayKey) {
    std::vector<std::string> objects;
    size_t pos = json.find("\"" + arrayKey + "\"");
    if (pos == std::string::npos) {
        return objects;
    }
    pos = json.find('[', pos);
    if (pos == std::string::npos) {
        return objects;
    }
    ++pos;

    int depth = 0;
    bool inString = false;
    size_t objectStart = 0;
    for (; pos < json.size(); ++pos) {
        const char c = json[pos];
        if (inString) {
            if (c == '\\') {
                ++pos;
            } else if (c == '"') {
                inString = false;
            }
            continue;
        }
        if (c == '"') {
            inString = true;
        } else if (c == '{') {
            if (depth == 0) {
                objectStart = pos;
            }
            ++depth;
        } else if (c == '}') {
            if (depth > 0 && --depth == 0) {
                objects.push_back(json.substr(objectStart, pos - objectStart + 1));
            }
        } else if (c == ']' && depth == 0) {
            break;
        }
    }
    return objects;
}

}  // namespace

std::vector<WebcamConfig> parseWebcamConfigs(const std::string& json) {
    std::vector<WebcamConfig> configs;
    for (const std::string& entry : splitTopLevelObjects(json, "webcams")) {
        if (configs.size() >= kMaxWebcams) {
            break;
        }
        WebcamConfig config;
        config.outputPath = findString(entry, "camPath");
        if (config.outputPath.empty()) {
            continue;
        }
        config.deviceId = findString(entry, "camDeviceId");
        config.deviceName = findString(entry, "camDeviceName");
        config.directShowClsid = findString(entry, "camClsid");
        config.width = findInt(entry, "camWidth", 0);
        config.height = findInt(entry, "camHeight", 0);
        config.fps = findInt(entry, "camFps", 0);
        configs.push_back(std::move(config));
    }
    if (!configs.empty() || !findBool(json, "webcamEnabled", false)) {
        return configs;
    }

    WebcamConfig legacy;
    legacy.outputPath = findString(json, "webcamPath");
    if (legacy.outputPath.empty()) {
        return configs;
    }
    legacy.deviceId = findString(json, "webcamDeviceId");
    legacy.deviceName = findString(json, "webcamDeviceName");
    legacy.directShowClsid = findString(json, "webcamDirectShowClsid");
    legacy.width = findInt(json, "webcamWidth", 0);
    legacy.height = findInt(json, "webcamHeight", 0);
    legacy.fps = findInt(json, "webcamFps", 0);
    configs.push_back(std::move(legacy));
    return configs;
}
