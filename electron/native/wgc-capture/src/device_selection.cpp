#include "device_selection.h"

#include <algorithm>
#include <cwctype>

namespace {

/**
 * Does one of these appear inside the other as WHOLE WORDS?
 *
 * Plain containment answered for devices that merely share a spelling: a
 * requested "Logi" is inside "Logitech", and "Micro" inside "Microphone",
 * neither of them as a word. Matching on that resolved a camera nobody asked
 * for -- and resolving one is exactly what stops the request reaching the
 * DirectShow fallback, where the cameras Media Foundation cannot enumerate live.
 *
 * Both sides arrive normalized, so a boundary is the start of the string, its
 * end, or a space.
 */
bool containsAsWords(const std::wstring& haystack, const std::wstring& needle) {
    if (haystack.empty() || needle.empty()) {
        return false;
    }
    size_t pos = haystack.find(needle);
    while (pos != std::wstring::npos) {
        const bool startsOnBoundary = pos == 0 || haystack[pos - 1] == L' ';
        const size_t after = pos + needle.size();
        const bool endsOnBoundary = after == haystack.size() || haystack[after] == L' ';
        if (startsOnBoundary && endsOnBoundary) {
            return true;
        }
        pos = haystack.find(needle, pos + 1);
    }
    return false;
}

bool containsInsensitive(const std::wstring& haystack, const std::wstring& needle) {
    return containsAsWords(haystack, needle) || containsAsWords(needle, haystack);
}

std::wstring normalizeDeviceName(const std::wstring& value) {
    std::wstring normalized;
    normalized.reserve(value.size());
    bool lastWasSpace = true;
    for (const wchar_t ch : value) {
        if (std::iswalnum(ch)) {
            normalized.push_back(static_cast<wchar_t>(std::towlower(ch)));
            lastWasSpace = false;
            continue;
        }
        if (!lastWasSpace) {
            normalized.push_back(L' ');
            lastWasSpace = true;
        }
    }
    while (!normalized.empty() && normalized.back() == L' ') {
        normalized.pop_back();
    }
    return normalized;
}

std::wstring toLower(const std::wstring& value) {
    std::wstring lowered;
    lowered.reserve(value.size());
    for (const wchar_t ch : value) {
        lowered.push_back(static_cast<wchar_t>(std::towlower(ch)));
    }
    return lowered;
}

} // namespace

bool DeviceClaims::contains(const std::wstring& identity) const {
    const std::wstring normalized = normalizeDeviceIdentity(identity);
    return !normalized.empty() &&
           std::find(identities_.begin(), identities_.end(), normalized) != identities_.end();
}

void DeviceClaims::add(const std::wstring& identity) {
    const std::wstring normalized = normalizeDeviceIdentity(identity);
    if (!normalized.empty() &&
        std::find(identities_.begin(), identities_.end(), normalized) == identities_.end()) {
        identities_.push_back(normalized);
    }
}

std::wstring normalizeDeviceIdentity(const std::wstring& identity) {
    const std::wstring lowered = toLower(identity);
    const size_t interfaceClass = lowered.rfind(L"#{");
    if (interfaceClass == std::wstring::npos || interfaceClass == 0) {
        return lowered;
    }
    const size_t classEnd = lowered.find(L'}', interfaceClass);
    if (classEnd == std::wstring::npos) {
        return lowered;
    }
    return lowered.substr(0, interfaceClass) + lowered.substr(classEnd + 1);
}

int deviceMatchScore(
    const std::wstring& candidateName,
    const std::wstring& candidateLink,
    const std::wstring& requestedName,
    const std::wstring& requestedId) {
    int score = 0;
    const auto normalizedName = normalizeDeviceName(candidateName);
    const auto normalizedLink = normalizeDeviceName(candidateLink);
    const auto normalizedRequestedName = normalizeDeviceName(requestedName);
    const auto normalizedRequestedId = normalizeDeviceName(requestedId);

    if (!normalizedRequestedName.empty()) {
        if (normalizedName == normalizedRequestedName) {
            score = std::max(score, 1000);
        }
        if (containsInsensitive(normalizedName, normalizedRequestedName)) {
            score = std::max(score, 900);
        }
        if (containsInsensitive(normalizedLink, normalizedRequestedName)) {
            score = std::max(score, 800);
        }
    }

    if (!normalizedRequestedId.empty()) {
        if (containsInsensitive(normalizedLink, normalizedRequestedId)) {
            score = std::max(score, 700);
        }
        if (containsInsensitive(normalizedName, normalizedRequestedId)) {
            score = std::max(score, 600);
        }
    }

    return score;
}

int selectUnclaimedDevice(
    const std::vector<DeviceCandidate>& candidates,
    const std::wstring& requestedName,
    const std::wstring& requestedId,
    const DeviceClaims& claims) {
    const bool requested = !requestedName.empty() || !requestedId.empty();
    int selected = -1;
    int bestScore = 0;
    for (size_t index = 0; index < candidates.size(); ++index) {
        if (claims.contains(candidates[index].identity)) {
            continue;
        }
        const int score =
            deviceMatchScore(candidates[index].name, candidates[index].identity, requestedName, requestedId);
        if (requested && score <= 0) {
            continue;
        }
        if (selected < 0 || score > bestScore) {
            selected = static_cast<int>(index);
            bestScore = score;
        }
    }
    return selected;
}
