#include "webcam_config.h"

#include <cstdio>
#include <string>

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
    const std::string legacy =
        R"({"fps":60,"width":2560,"height":1440,"webcamEnabled":true,"webcamDeviceId":"id1",)"
        R"("webcamDeviceName":"Cam One","webcamDirectShowClsid":"{A}","webcamWidth":1920,)"
        R"("webcamHeight":1080,"webcamFps":30,"outputs":{"screenPath":"s.mp4","webcamPath":"w.mp4"}})";
    auto l = parseWebcamConfigs(legacy);
    expect(l.size() == 1, "legacy: one camera");
    expect(l.size() == 1 && l[0].deviceName == "Cam One" && l[0].outputPath == "w.mp4" &&
               l[0].width == 1920 && l[0].fps == 30,
           "legacy: fields");

    expect(parseWebcamConfigs(R"({"webcamEnabled":false,"webcamPath":"w.mp4"})").empty(),
           "legacy disabled: none");

    const std::string list =
        R"({"fps":60,"width":2560,"webcamEnabled":true,"webcamDeviceName":"Cam One","webcamPath":"w.mp4",)"
        R"("webcams":[{"camDeviceId":"id1","camDeviceName":"Cam One","camClsid":"{A}","camWidth":1920,)"
        R"("camHeight":1080,"camFps":30,"camPath":"w.mp4"},)"
        R"({"camDeviceId":"id2","camDeviceName":"Desk \"Cam\"","camClsid":"","camWidth":1280,)"
        R"("camHeight":720,"camFps":30,"camPath":"w-2.mp4"}]})";
    auto m = parseWebcamConfigs(list);
    expect(m.size() == 2, "list: two cameras");
    expect(m.size() == 2 && m[1].deviceName == "Desk \"Cam\"" && m[1].outputPath == "w-2.mp4" &&
               m[1].width == 1280 && m[1].height == 720,
           "list: second camera fields, escaped quote");
    expect(m.size() == 2 && m[0].fps == 30, "list: entry fps not the top-level fps");

    expect(parseWebcamConfigs(R"({"webcamEnabled":true,"webcamPath":"w.mp4","webcams":[]})").size() == 1,
           "empty list falls back to legacy");

    std::string five = R"({"webcams":[)";
    for (int i = 0; i < 5; ++i) {
        five += (i ? "," : "");
        five += R"({"camDeviceName":"C","camPath":"p)" + std::to_string(i) + R"(.mp4"})";
    }
    five += "]}";
    expect(parseWebcamConfigs(five).size() == 4, "capped at four");

    expect(parseWebcamConfigs(R"({"webcams":[{"camDeviceName":"No path"}]})").empty(),
           "entry without camPath is skipped");

    if (failures == 0) {
        std::printf("webcam_config_test: all assertions passed\n");
        return 0;
    }
    std::printf("webcam_config_test: %d assertion(s) failed\n", failures);
    return 1;
}
