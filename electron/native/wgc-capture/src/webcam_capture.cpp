#include "webcam_capture.h"

#include "realtime_scheduling.h"
#include "webcam_format.h"

#include <mfapi.h>
#include <mferror.h>
#include <propvarutil.h>

#include <algorithm>
#include <chrono>
#include <iostream>

namespace {

bool succeeded(HRESULT hr, const char* label) {
    if (SUCCEEDED(hr)) {
        return true;
    }

    std::cerr << "ERROR: " << label << " failed (hr=0x" << std::hex << hr << std::dec << ")"
              << std::endl;
    return false;
}

std::wstring readAllocatedString(IMFActivate* activate, REFGUID key) {
    WCHAR* value = nullptr;
    UINT32 length = 0;
    if (FAILED(activate->GetAllocatedString(key, &value, &length)) || !value) {
        return {};
    }

    std::wstring result(value, value + length);
    CoTaskMemFree(value);
    return result;
}

} // namespace

WebcamCapture::~WebcamCapture() {
    stop();
}

bool WebcamCapture::initialize(
    const std::wstring& deviceId,
    const std::wstring& deviceName,
    const std::wstring& directShowClsid,
    int requestedWidth,
    int requestedHeight,
    int requestedFps,
    bool preferNv12,
    DeviceClaims& claims) {
    fps_ = std::clamp(requestedFps > 0 ? requestedFps : 30, 1, 60);
    usingDirectShow_ = false;
    selectedIdentity_.clear();
    const auto initializeDirectShow = [&]() {
        if (!directShowCapture_.initialize(
                deviceId, deviceName, directShowClsid, requestedWidth, requestedHeight, fps_, claims)) {
            if (!deviceId.empty() || !deviceName.empty()) {
                std::cerr << "ERROR: Requested webcam device was not found by native Windows webcam providers"
                          << std::endl;
            }
            return false;
        }
        usingDirectShow_ = true;
        claims.add(directShowCapture_.deviceIdentity());
        return true;
    };

    if (!succeeded(MFStartup(MF_VERSION), "MFStartup(webcam)")) {
        return initializeDirectShow();
    }
    mfStarted_ = true;
    if (!selectDevice(deviceId, deviceName, claims)) {
        if (mfStarted_) {
            MFShutdown();
            mfStarted_ = false;
        }
        return initializeDirectShow();
    }

    if (!configureReader(requestedWidth, requestedHeight, fps_, preferNv12)) {
        return false;
    }
    claims.add(selectedIdentity_);
    return true;
}

bool WebcamCapture::selectDevice(
    const std::wstring& deviceId,
    const std::wstring& deviceName,
    const DeviceClaims& claims) {
    Microsoft::WRL::ComPtr<IMFAttributes> attributes;
    if (!succeeded(MFCreateAttributes(&attributes, 1), "MFCreateAttributes(webcam enumeration)")) {
        return false;
    }
    if (!succeeded(attributes->SetGUID(
            MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
            MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID),
            "SetGUID(webcam source type)")) {
        return false;
    }

    IMFActivate** devices = nullptr;
    UINT32 deviceCount = 0;
    HRESULT hr = MFEnumDeviceSources(attributes.Get(), &devices, &deviceCount);
    if (!succeeded(hr, "MFEnumDeviceSources") || deviceCount == 0) {
        if (devices) {
            CoTaskMemFree(devices);
        }
        std::cerr << "ERROR: No native Windows webcam devices were found" << std::endl;
        return false;
    }

    std::vector<DeviceCandidate> candidates;
    candidates.reserve(deviceCount);
    bool anyClaimed = false;
    for (UINT32 index = 0; index < deviceCount; index += 1) {
        DeviceCandidate candidate{
            readAllocatedString(devices[index], MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME),
            readAllocatedString(devices[index], MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK)};
        const bool claimed = claims.contains(candidate.identity);
        anyClaimed = anyClaimed || claimed;
        std::wcerr << L"INFO: Native webcam candidate [" << index << L"] name=\"" << candidate.name
                   << L"\" score=" << deviceMatchScore(candidate.name, candidate.identity, deviceName, deviceId)
                   << (claimed ? L" (already recording in this take)" : L"") << std::endl;
        candidates.push_back(std::move(candidate));
    }

    const int selectedIndex = selectUnclaimedDevice(candidates, deviceName, deviceId, claims);
    if (selectedIndex >= 0) {
        selectedDeviceName_ = candidates[selectedIndex].name;
        selectedIdentity_ = candidates[selectedIndex].identity;
        hr = devices[selectedIndex]->ActivateObject(IID_PPV_ARGS(&mediaSource_));
    } else if (anyClaimed) {
        std::cerr << "WARNING: Every matching webcam is already recording in this take; trying DirectShow"
                  << std::endl;
    } else {
        std::cerr << "WARNING: Requested webcam device was not found by Media Foundation; trying DirectShow"
                  << std::endl;
    }

    for (UINT32 index = 0; index < deviceCount; index += 1) {
        devices[index]->Release();
    }
    CoTaskMemFree(devices);

    return selectedIndex >= 0 && succeeded(hr, "ActivateObject(webcam)");
}

namespace {

/**
 * Is this subtype something the source reader must DECODE before it can convert?
 *
 * Listed positively -- an unknown subtype counts as compressed -- because the
 * cost of guessing wrong the other way is a camera that silently records
 * nothing, while guessing wrong this way only costs resolution.
 */
bool isCompressedVideoSubtype(const GUID& subtype) {
    static const GUID* const kUncompressed[] = {
        &MFVideoFormat_NV12,
        &MFVideoFormat_YUY2,
        &MFVideoFormat_RGB32,
        &MFVideoFormat_RGB24,
        &MFVideoFormat_ARGB32,
        &MFVideoFormat_UYVY,
        &MFVideoFormat_YV12,
        &MFVideoFormat_I420,
        &MFVideoFormat_IYUV,
    };
    for (const GUID* candidate : kUncompressed) {
        if (subtype == *candidate) {
            return false;
        }
    }
    return true;
}

/**
 * Every video format the camera advertises, read off the source reader.
 *
 * MF_MT_FRAME_RATE is a ratio; a 30000/1001 entry is NTSC 29.97 and rounds to
 * 30, which is what we want to compare against the requested rate. A type
 * missing either attribute is skipped rather than guessed at -- it cannot be
 * requested by size anyway.
 */
std::vector<WebcamFormat> readNativeFormats(IMFSourceReader* reader) {
    std::vector<WebcamFormat> formats;
    for (DWORD index = 0;; ++index) {
        Microsoft::WRL::ComPtr<IMFMediaType> nativeType;
        const HRESULT hr =
            reader->GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, index, &nativeType);
        if (hr == MF_E_NO_MORE_TYPES || FAILED(hr)) {
            break;
        }

        UINT32 width = 0;
        UINT32 height = 0;
        if (FAILED(MFGetAttributeSize(nativeType.Get(), MF_MT_FRAME_SIZE, &width, &height))) {
            continue;
        }

        UINT32 numerator = 0;
        UINT32 denominator = 0;
        int fps = 0;
        if (SUCCEEDED(MFGetAttributeRatio(nativeType.Get(), MF_MT_FRAME_RATE, &numerator, &denominator)) &&
            denominator > 0) {
            fps = static_cast<int>((numerator + denominator / 2) / denominator);
        }

        GUID subtype{};
        const bool compressed = SUCCEEDED(nativeType->GetGUID(MF_MT_SUBTYPE, &subtype))
                                    ? isCompressedVideoSubtype(subtype)
                                    : true;

        formats.push_back(
            WebcamFormat{static_cast<int>(width), static_cast<int>(height), fps, compressed});
    }
    return formats;
}


/**
 * Puts the camera itself on `wanted` by selecting the matching native type.
 *
 * Best-effort: a driver that refuses leaves the reader on whatever it had, and
 * the RGB32 request that follows still produces a usable -- if smaller -- frame.
 */
void selectNativeFormat(IMFSourceReader* reader, const WebcamFormat& wanted) {
    for (DWORD index = 0;; ++index) {
        Microsoft::WRL::ComPtr<IMFMediaType> nativeType;
        const HRESULT hr =
            reader->GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, index, &nativeType);
        if (hr == MF_E_NO_MORE_TYPES || FAILED(hr)) {
            return;
        }

        UINT32 width = 0;
        UINT32 height = 0;
        if (FAILED(MFGetAttributeSize(nativeType.Get(), MF_MT_FRAME_SIZE, &width, &height))) {
            continue;
        }
        if (static_cast<int>(width) != wanted.width || static_cast<int>(height) != wanted.height) {
            continue;
        }

        GUID subtype{};
        if (FAILED(nativeType->GetGUID(MF_MT_SUBTYPE, &subtype)) ||
            isCompressedVideoSubtype(subtype) != wanted.compressed) {
            continue;
        }

        UINT32 numerator = 0;
        UINT32 denominator = 0;
        if (wanted.fps > 0 &&
            SUCCEEDED(MFGetAttributeRatio(nativeType.Get(), MF_MT_FRAME_RATE, &numerator, &denominator)) &&
            denominator > 0) {
            const int fps = static_cast<int>((numerator + denominator / 2) / denominator);
            if (fps != wanted.fps) {
                continue;
            }
        }

        if (SUCCEEDED(reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, nativeType.Get()))) {
            return;
        }
    }
}

}  // namespace

bool WebcamCapture::configureReader(
    int requestedWidth,
    int requestedHeight,
    int requestedFps,
    bool preferNv12) {
    Microsoft::WRL::ComPtr<IMFAttributes> attributes;
    if (!succeeded(MFCreateAttributes(&attributes, 3), "MFCreateAttributes(webcam reader)")) {
        return false;
    }
    attributes->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);
    attributes->SetUINT32(MF_READWRITE_DISABLE_CONVERTERS, FALSE);
    // Ask the pipeline to minimize internal buffering/lookahead so a frame
    // reaches ReadSample() as soon as possible after the driver delivers it,
    // rather than sitting queued behind MF's default lookahead buffering.
    attributes->SetUINT32(MF_LOW_LATENCY, TRUE);

    if (!succeeded(MFCreateSourceReaderFromMediaSource(mediaSource_.Get(), attributes.Get(), &sourceReader_),
                   "MFCreateSourceReaderFromMediaSource(webcam)")) {
        return false;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> mediaType;
    if (!succeeded(MFCreateMediaType(&mediaType), "MFCreateMediaType(webcam output)")) {
        return false;
    }
    mediaType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    // NV12 when the frame only has to reach the webcam encoder, which wants
    // NV12 anyway. Asking for RGB32 instead makes the source reader decode AND
    // convert every frame: measured at 92ms per 3840x2160 frame against 32ms
    // for NV12, which is the difference between 11 fps and the camera's full
    // 30. BGRA is still used when the frame is composited into the screen
    // recording inline, which needs it in that layout.
    deliversNv12_ = preferNv12;
    mediaType->SetGUID(MF_MT_SUBTYPE, preferNv12 ? MFVideoFormat_NV12 : MFVideoFormat_RGB32);

    // Pick the capture format, then SELECT it on the source before asking for
    // RGB32 output.
    //
    // Both halves matter. Handing Media Foundation an output type with no
    // MF_MT_FRAME_SIZE leaves the device on its default format -- 640x480 on a
    // BRIO that offers 3840x2160 -- and that default is what the overlay was
    // upscaling. But naming the size on the *output* type alone is not enough
    // either: with MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING the reader answers
    // S_OK by inserting a converter in front of whichever native type is
    // already selected, so the camera keeps running at 640x480 and the size we
    // asked for is quietly dropped. Selecting the native type first is what
    // actually reconfigures the camera.
    const WebcamFormat chosen = chooseWebcamFormat(
        readNativeFormats(sourceReader_.Get()),
        requestedWidth > 0 ? requestedWidth : 1920,
        requestedHeight > 0 ? requestedHeight : 1080,
        std::max(1, requestedFps));
    std::cerr << "INFO: Native webcam format " << chosen.width << "x" << chosen.height << "@"
              << chosen.fps << (chosen.compressed ? " (compressed)" : " (uncompressed)") << std::endl;
    selectNativeFormat(sourceReader_.Get(), chosen);

    MFSetAttributeSize(
        mediaType.Get(), MF_MT_FRAME_SIZE, static_cast<UINT32>(chosen.width), static_cast<UINT32>(chosen.height));
    MFSetAttributeRatio(mediaType.Get(), MF_MT_FRAME_RATE, static_cast<UINT32>(std::max(1, requestedFps)), 1);

    if (FAILED(sourceReader_->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, mediaType.Get()))) {
        // Some drivers refuse a size they nonetheless enumerate. A slightly soft
        // camera beats no camera, so drop the size and let the driver choose --
        // exactly what this code did before it asked for anything.
        std::cerr << "WARNING: Webcam rejected " << chosen.width << "x" << chosen.height
                  << "; falling back to the device default format" << std::endl;
        Microsoft::WRL::ComPtr<IMFMediaType> fallbackType;
        if (!succeeded(MFCreateMediaType(&fallbackType), "MFCreateMediaType(webcam fallback)")) {
            return false;
        }
        fallbackType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        fallbackType->SetGUID(MF_MT_SUBTYPE, preferNv12 ? MFVideoFormat_NV12 : MFVideoFormat_RGB32);
        if (!succeeded(
                sourceReader_->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, fallbackType.Get()),
                "SetCurrentMediaType(webcam RGB32)")) {
            return false;
        }
    }
    sourceReader_->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE);
    sourceReader_->SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM, TRUE);

    Microsoft::WRL::ComPtr<IMFMediaType> currentType;
    if (!succeeded(sourceReader_->GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, &currentType),
                   "GetCurrentMediaType(webcam)")) {
        return false;
    }

    UINT32 width = 0;
    UINT32 height = 0;
    if (FAILED(MFGetAttributeSize(currentType.Get(), MF_MT_FRAME_SIZE, &width, &height)) || width == 0 || height == 0) {
        width = static_cast<UINT32>(requestedWidth > 0 ? requestedWidth : 1280);
        height = static_cast<UINT32>(requestedHeight > 0 ? requestedHeight : 720);
    }
    width_ = static_cast<int>(width);
    height_ = static_cast<int>(height);
    return true;
}

bool WebcamCapture::start() {
    if (usingDirectShow_) {
        return directShowCapture_.start();
    }
    if (!sourceReader_ || thread_.joinable()) {
        return false;
    }

    stopRequested_ = false;
    thread_ = std::thread(&WebcamCapture::captureLoop, this);
    return true;
}

void WebcamCapture::stop() {
    directShowCapture_.stop();
    stopRequested_ = true;
    if (thread_.joinable()) {
        thread_.join();
    }
    if (mediaSource_) {
        mediaSource_->Shutdown();
    }
    sourceReader_.Reset();
    mediaSource_.Reset();
    if (mfStarted_) {
        MFShutdown();
        mfStarted_ = false;
    }
}

void WebcamCapture::captureLoop() {
    const MmcssThread mmcss(L"Capture");
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const auto loopStartedAt = std::chrono::steady_clock::now();

    while (!stopRequested_) {
        DWORD streamIndex = 0;
        DWORD flags = 0;
        LONGLONG timestamp = 0;
        Microsoft::WRL::ComPtr<IMFSample> sample;
        const auto readStartedAt = std::chrono::steady_clock::now();
        HRESULT hr = sourceReader_->ReadSample(
            MF_SOURCE_READER_FIRST_VIDEO_STREAM,
            0,
            &streamIndex,
            &flags,
            &timestamp,
            &sample);
        readSampleUs_ += static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - readStartedAt)
                .count());
        (void)streamIndex;
        (void)timestamp;

        if (FAILED(hr)) {
            // Counted, not printed: a reader that fails every call would other-
            // wise write thousands of identical lines over a long take.
            readFailures_ += 1;
            lastReadFailure_ = hr;
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
            continue;
        }
        if ((flags & MF_SOURCE_READERF_ENDOFSTREAM) != 0) {
            sawEndOfStream_ = true;
            break;
        }
        if (!sample) {
            // Normal in small numbers (MF_SOURCE_READERF_STREAMTICK); a run of
            // nothing else is a camera that never started producing.
            emptySamples_ += 1;
            continue;
        }

        // `Lock()` below is enough; row padding cannot reach `latestFrame_`.
        //
        // A 2-D media buffer may well pad each row out to a stride wider than
        // the frame, but that padding is never what `Lock()` hands back:
        // "The Lock method returns a buffer that is guaranteed to be
        // contiguous. If the underlying buffer is not contiguous, the method
        // copies the data into a new buffer" (IMF2DBuffer, Remarks). Reading
        // the native pitch through IMF2DBuffer::Lock2D would only be worth it
        // as a measured optimisation -- it saves that copy -- and mixing the
        // two interfaces on one buffer is advised against in the same page.
        Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer;
        if (FAILED(sample->ConvertToContiguousBuffer(&buffer)) || !buffer) {
            bufferFailures_ += 1;
            continue;
        }

        BYTE* data = nullptr;
        DWORD maxLength = 0;
        DWORD currentLength = 0;
        if (FAILED(buffer->Lock(&data, &maxLength, &currentLength)) || !data) {
            bufferFailures_ += 1;
            continue;
        }

        const int pixels = std::max(0, width_) * std::max(0, height_);
        const DWORD expectedLength =
            static_cast<DWORD>(deliversNv12_ ? pixels * 3 / 2 : pixels * 4);
        if (currentLength >= expectedLength && expectedLength > 0) {
            if (framesDelivered_ == 0) {
                const auto waitedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                          std::chrono::steady_clock::now() - loopStartedAt)
                                          .count();
                std::cerr << "INFO: First webcam frame after " << waitedMs << "ms" << std::endl;
            }
            framesDelivered_ += 1;
            const auto storeStartedAt = std::chrono::steady_clock::now();
            {
                std::scoped_lock lock(frameMutex_);
                latestFrame_.assign(data, data + expectedLength);
                latestFrameSequence_ += 1;
            }
            storeUs_ += static_cast<uint64_t>(
                std::chrono::duration_cast<std::chrono::microseconds>(
                    std::chrono::steady_clock::now() - storeStartedAt)
                    .count());
        } else if (shortBuffers_++, !reportedShortBuffer_) {
            // Every frame arriving short means the reader is handing us something
            // other than the RGB32 we asked for -- a compressed frame it never
            // converted, most often. Silently dropped, that reads downstream as a
            // camera that produced nothing at all, with no clue why. Said once,
            // because it is true for every frame that follows.
            reportedShortBuffer_ = true;
            std::cerr << "WARNING: Webcam frame is " << currentLength << " bytes, expected "
                      << expectedLength << " for " << width_ << "x" << height_ << " "
                      << (deliversNv12_ ? "NV12" : "RGB32") << "; dropping frames" << std::endl;
        }

        buffer->Unlock();
    }

    std::cerr << "INFO: Webcam capture loop ended: delivered=" << framesDelivered_
              << " emptySamples=" << emptySamples_ << " shortBuffers=" << shortBuffers_
              << " bufferFailures=" << bufferFailures_ << " readFailures=" << readFailures_
              << " lastReadHr=0x" << std::hex << lastReadFailure_ << std::dec
              << " endOfStream=" << (sawEndOfStream_ ? "yes" : "no")
              << " readSampleMs=" << (readSampleUs_ / 1000) << " storeMs=" << (storeUs_ / 1000)
              << std::endl;

    CoUninitialize();
}

bool WebcamCapture::copyLatestFrame(WebcamFrameSnapshot& destination, uint64_t lastSeenSequence) {
    if (usingDirectShow_) {
        return directShowCapture_.copyLatestFrame(destination, lastSeenSequence);
    }
    std::scoped_lock lock(frameMutex_);
    return snapshotWebcamFrame(
        latestFrame_, width_, height_, latestFrameSequence_, lastSeenSequence, destination);
}

bool WebcamCapture::deliversNv12() const {
    return !usingDirectShow_ && deliversNv12_;
}

int WebcamCapture::width() const {
    if (usingDirectShow_) {
        return directShowCapture_.width();
    }
    return width_;
}

int WebcamCapture::height() const {
    if (usingDirectShow_) {
        return directShowCapture_.height();
    }
    return height_;
}

int WebcamCapture::fps() const {
    if (usingDirectShow_) {
        return directShowCapture_.fps();
    }
    return fps_;
}

const std::wstring& WebcamCapture::selectedDeviceName() const {
    if (usingDirectShow_) {
        return directShowCapture_.selectedDeviceName();
    }
    return selectedDeviceName_;
}
