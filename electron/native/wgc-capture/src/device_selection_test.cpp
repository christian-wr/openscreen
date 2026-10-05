#include "device_selection.h"

#include <cstdio>
#include <string>
#include <vector>

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
    const std::vector<DeviceCandidate> twins = {
        {L"USB Camera", L"\\\\?\\usb#vid_0c45&pid_6366&mi_00#7&aaa&0&0000#{e5323777-f976-4f5b-9b55-b94699c46e44}\\global"},
        {L"USB Camera", L"\\\\?\\usb#vid_0c45&pid_6366&mi_00#7&bbb&0&0000#{e5323777-f976-4f5b-9b55-b94699c46e44}\\global"},
    };

    DeviceClaims none;
    expect(selectUnclaimedDevice(twins, L"USB Camera", L"", none) == 0,
           "same names, nothing claimed: first");

    DeviceClaims first;
    first.add(twins[0].identity);
    expect(selectUnclaimedDevice(twins, L"USB Camera", L"", first) == 1,
           "same names, first claimed: second");

    DeviceClaims both;
    both.add(twins[0].identity);
    both.add(twins[1].identity);
    expect(selectUnclaimedDevice(twins, L"USB Camera", L"", both) == -1,
           "same names, both claimed: none");
    expect(selectUnclaimedDevice(twins, L"", L"", both) == -1,
           "nothing requested, both claimed: none");

    DeviceClaims upper;
    upper.add(L"\\\\?\\USB#VID_0C45&PID_6366&MI_00#7&AAA&0&0000#{E5323777-F976-4F5B-9B55-B94699C46E44}\\GLOBAL");
    expect(selectUnclaimedDevice(twins, L"USB Camera", L"", upper) == 1,
           "claim comparison is case-insensitive");

    // DirectShow registers the same device under its own interface class GUID.
    DeviceClaims viaDirectShow;
    viaDirectShow.add(
        L"\\\\?\\usb#vid_0c45&pid_6366&mi_00#7&aaa&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global");
    expect(viaDirectShow.contains(twins[0].identity), "MF link and DirectShow path are one device");
    expect(!viaDirectShow.contains(twins[1].identity), "the twin is a different device");

    const std::vector<DeviceCandidate> mixed = {
        {L"Studio Cam", L"\\\\?\\usb#vid_1#a#{e5323777-f976-4f5b-9b55-b94699c46e44}\\global"},
        {L"Studio Cam Pro", L"\\\\?\\usb#vid_2#b#{e5323777-f976-4f5b-9b55-b94699c46e44}\\global"},
        {L"Other Camera", L"\\\\?\\usb#vid_3#c#{e5323777-f976-4f5b-9b55-b94699c46e44}\\global"},
    };
    DeviceClaims exact;
    exact.add(mixed[0].identity);
    expect(selectUnclaimedDevice(mixed, L"Studio Cam", L"", none) == 0, "exact name wins unclaimed");
    expect(selectUnclaimedDevice(mixed, L"Studio Cam", L"", exact) == 1,
           "claimed exact match loses to a weaker unclaimed match");
    DeviceClaims bothStudio = exact;
    bothStudio.add(mixed[1].identity);
    expect(selectUnclaimedDevice(mixed, L"Studio Cam", L"", bothStudio) == -1,
           "a non-matching device is never picked for a request");
    expect(selectUnclaimedDevice(mixed, L"Nonexistent", L"", none) == -1,
           "no match for a request: none");
    expect(selectUnclaimedDevice(mixed, L"", L"", none) == 0, "nothing requested: first device");
    expect(selectUnclaimedDevice(mixed, L"", L"", exact) == 1,
           "nothing requested: first unclaimed device");
    expect(selectUnclaimedDevice({}, L"", L"", none) == -1, "no candidates: none");

    // Measured on an ARM64 dev machine: the front camera as Media Foundation and
    // as DirectShow list it.
    DeviceClaims frontCamera;
    frontCamera.add(
        L"\\\\?\\display#qcom_avstream_8380#3&2dd9d5f4&0&uid32768#{e5323777-f976-4f5b-9b55-b94699c46e44}"
        L"\\{4faeafd4-041b-4e46-85fd-400473891182}");
    expect(frontCamera.contains(
               L"\\\\?\\DISPLAY#QCOM_AVSTREAM_8380#3&2DD9D5F4&0&UID32768#{65E8773D-8F56-11D0-A3B9-00A0C9223196}"
               L"\\{4FAEAFD4-041B-4E46-85FD-400473891182}"),
           "measured MF link and DirectShow path are one device");
    expect(!frontCamera.contains(
               L"\\\\?\\display#qcom_avstream_8380#3&2dd9d5f4&0&uid32768#{e5323777-f976-4f5b-9b55-b94699c46e44}"
               L"\\{00000000-0000-0000-0000-000000000001}"),
           "another reference string on the same device is another camera");

    DeviceClaims empty;
    empty.add(L"");
    expect(!empty.contains(L""), "an empty identity is never claimed");
    expect(normalizeDeviceIdentity(L"@device:sw:{ABC}") == L"@device:sw:{abc}",
           "identity without an interface class is only lowercased");

    if (failures == 0) {
        std::printf("device_selection_test: all assertions passed\n");
        return 0;
    }
    std::printf("device_selection_test: %d failure(s)\n", failures);
    return 1;
}
