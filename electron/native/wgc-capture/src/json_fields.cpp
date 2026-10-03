#include "json_fields.h"

#include <cctype>
#include <cstdint>

// Lightweight field lookups over the helper's single JSON argument. They match
// the first occurrence of a key anywhere in the document.

bool findBool(const std::string& json, const std::string& key, bool fallback) {
    auto pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos) {
        return fallback;
    }
    pos = json.find(':', pos);
    if (pos == std::string::npos) {
        return fallback;
    }
    pos += 1;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
        pos += 1;
    }
    if (json.compare(pos, 4, "true") == 0) {
        return true;
    }
    if (json.compare(pos, 5, "false") == 0) {
        return false;
    }
    return fallback;
}

int64_t findInt64(const std::string& json, const std::string& key, int64_t fallback) {
    auto pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos) {
        return fallback;
    }
    pos = json.find(':', pos);
    if (pos == std::string::npos) {
        return fallback;
    }
    pos += 1;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
        pos += 1;
    }
    try {
        return std::stoll(json.substr(pos));
    } catch (...) {
        return fallback;
    }
}

int findInt(const std::string& json, const std::string& key, int fallback) {
    return static_cast<int>(findInt64(json, key, fallback));
}

double findDouble(const std::string& json, const std::string& key, double fallback) {
    auto pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos) {
        return fallback;
    }
    pos = json.find(':', pos);
    if (pos == std::string::npos) {
        return fallback;
    }
    pos += 1;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
        pos += 1;
    }
    try {
        return std::stod(json.substr(pos));
    } catch (...) {
        return fallback;
    }
}

std::string findString(const std::string& json, const std::string& key) {
    auto pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos) {
        return {};
    }
    pos = json.find(':', pos);
    if (pos == std::string::npos) {
        return {};
    }
    pos += 1;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
        pos += 1;
    }
    if (pos >= json.size() || json[pos] != '"') {
        return {};
    }
    pos += 1;

    std::string result;
    while (pos < json.size()) {
        const char c = json[pos++];
        if (c == '"') {
            break;
        }
        if (c == '\\' && pos < json.size()) {
            const char escaped = json[pos++];
            switch (escaped) {
                case '\\':
                case '"':
                case '/':
                    result.push_back(escaped);
                    break;
                case 'n':
                    result.push_back('\n');
                    break;
                case 'r':
                    result.push_back('\r');
                    break;
                case 't':
                    result.push_back('\t');
                    break;
                default:
                    result.push_back(escaped);
                    break;
            }
            continue;
        }
        result.push_back(c);
    }
    return result;
}
