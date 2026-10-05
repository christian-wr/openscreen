#pragma once

#include <cstdint>
#include <string>

bool findBool(const std::string& json, const std::string& key, bool fallback);
int64_t findInt64(const std::string& json, const std::string& key, int64_t fallback);
int findInt(const std::string& json, const std::string& key, int fallback);
double findDouble(const std::string& json, const std::string& key, double fallback);
std::string findString(const std::string& json, const std::string& key);
