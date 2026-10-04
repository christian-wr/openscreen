#pragma once

#include <string>
#include <vector>

/**
 * Which camera devices are already recording in this take.
 *
 * Two webcams of the same model report the same friendly name, and the id the
 * browser hands us is a salted hash that never matches a device path, so name
 * matching alone sends every such camera to the FIRST physical device. The
 * second open then fails as busy and that camera is lost. Each camera that
 * opens adds its device identity here, and later cameras of the take skip it.
 *
 * Identities are compared normalized (see `normalizeDeviceIdentity`), so a
 * device opened through Media Foundation is recognized when it turns up again
 * on the DirectShow fallback.
 */
class DeviceClaims {
public:
    bool contains(const std::wstring& identity) const;
    /** Ignores an empty identity: a device we cannot name cannot be claimed. */
    void add(const std::wstring& identity);

private:
    std::vector<std::wstring> identities_;
};

/** One device a capture backend enumerated. */
struct DeviceCandidate {
    std::wstring name;
    /** The Media Foundation symbolic link or the DirectShow DevicePath. */
    std::wstring identity;
};

/**
 * The part of a device interface path that names the physical device.
 *
 * Media Foundation's symbolic link and DirectShow's DevicePath are the same
 * `\\?\usb#vid_…#<instance>#{interface class}\<reference>` string, except that
 * each registers the camera under its own interface class GUID (measured on a
 * Snapdragon front camera: KSCATEGORY_VIDEO_CAMERA against KSCATEGORY_VIDEO).
 * Dropping the `#{…}` class and lowercasing leaves the device instance plus the
 * reference string, which both share. The reference string is kept because it
 * tells apart two cameras of one device (a colour and an IR sensor). A value
 * without that shape (a moniker display name) is only lowercased.
 */
std::wstring normalizeDeviceIdentity(const std::wstring& identity);

/**
 * How well a candidate answers a requested name, or 0 for "not this one".
 *
 * Only decisive matches count: the names being equal once normalized, or one
 * containing the other -- which is the ordinary case, since Chromium appends USB
 * ids to what the driver reports.
 *
 * A further tier used to score shared WORDS, to bridge names differing more than
 * that. It bridged names that were not the same device. "Logi Capture" and
 * "Logitech StreamCam" share no word, yet "logi" sits inside "logitech" and that
 * scored high enough to win -- so asking for a camera Media Foundation cannot
 * enumerate opened a DIFFERENT camera, instead of returning nothing and letting
 * the DirectShow fallback find the real one (getopenscreen/openscreen#405).
 *
 * Returning 0 is what makes that fallback reachable, so it is a real answer
 * rather than a weak match. Keep this in step with
 * `electron/recording/deviceNameMatching.ts`, which states the same rules for
 * the Electron side and carries their unit tests.
 */
int deviceMatchScore(
    const std::wstring& candidateName,
    const std::wstring& candidateLink,
    const std::wstring& requestedName,
    const std::wstring& requestedId);

/**
 * The candidate a camera should open, or -1 for none.
 *
 * Claimed candidates are skipped; among the rest the best `deviceMatchScore`
 * wins, the earlier one on a tie. With nothing requested that is the first
 * unclaimed device. With a name or id requested, a candidate scoring 0 is never
 * picked -- the same rule as before claims existed, and what lets the caller
 * fall back to DirectShow. With an empty claim set this is exactly the old
 * selection.
 */
int selectUnclaimedDevice(
    const std::vector<DeviceCandidate>& candidates,
    const std::wstring& requestedName,
    const std::wstring& requestedId,
    const DeviceClaims& claims);
