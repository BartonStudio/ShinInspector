#include "TestObject.hpp"

#include <iobject/Runtime.hpp>  // Runtime::make<DataChannelChangedEventData>

#include <array>
#include <cstdio>
#include <utility>

TestObject::TestObject(std::string name) : name_(std::move(name)) {}
TestObject::~TestObject() = default;

void TestObject::BindRuntime(iobject::IRuntimeObject* self) {
    self_ = self;
}

bool TestObject::ReadData(iobject::DataChannelView channel, iobject::DataReceiver receiver) const {
    if (channel == "State") {
        const std::array<std::uint8_t, 1> bytes{state_};
        receiver(iobject::ByteView(bytes.data(), bytes.size()));
        return true;
    }
    if (channel == "Counter") {
        const std::array<std::uint8_t, 4> bytes{
            static_cast<std::uint8_t>((counter_ >> 24) & 0xff),
            static_cast<std::uint8_t>((counter_ >> 16) & 0xff),
            static_cast<std::uint8_t>((counter_ >> 8) & 0xff),
            static_cast<std::uint8_t>(counter_ & 0xff)};
        receiver(iobject::ByteView(bytes.data(), bytes.size()));
        return true;
    }
    if (channel == "Text") {
        receiver(iobject::ByteView(
            reinterpret_cast<const std::uint8_t*>(text_.data()), text_.size()));
        return true;
    }
    return false;
}

bool TestObject::WriteData(iobject::DataChannelView channel, iobject::ByteInput data) {
    if (channel == "State" && data.size() == 1) {
        state_ = data[0] != 0 ? 1 : 0;
        std::fprintf(stderr, "[TestObject:%s] State -> %u\n", name_.c_str(),
                     static_cast<unsigned>(state_));
        publishChannelChanged("State");
        return true;
    }
    if (channel == "Counter" && data.size() == 4) {
        counter_ = (static_cast<std::uint32_t>(data[0]) << 24)
                 | (static_cast<std::uint32_t>(data[1]) << 16)
                 | (static_cast<std::uint32_t>(data[2]) << 8)
                 | (static_cast<std::uint32_t>(data[3]));
        std::fprintf(stderr, "[TestObject:%s] Counter -> %u\n", name_.c_str(), counter_);
        publishChannelChanged("Counter");
        return true;
    }
    if (channel == "Text") {
        text_.assign(reinterpret_cast<const char*>(data.data()), data.size());
        std::fprintf(stderr, "[TestObject:%s] Text -> \"%s\"\n", name_.c_str(), text_.c_str());
        publishChannelChanged("Text");
        return true;
    }
    return false;
}

bool TestObject::Invoke(iobject::MethodView method, iobject::ByteInput args, iobject::DataReceiver result) {
    if (method == "Echo") {
        result(args);
        return true;
    }
    if (method == "Toggle") {
        state_ = state_ ? 0 : 1;
        std::fprintf(stderr, "[TestObject:%s] Toggle -> %u\n", name_.c_str(),
                     static_cast<unsigned>(state_));
        publishChannelChanged("State");
        const std::array<std::uint8_t, 1> bytes{state_};
        result(iobject::ByteView(bytes.data(), bytes.size()));
        return true;
    }
    if (method == "Bump") {
        ++counter_;
        std::fprintf(stderr, "[TestObject:%s] Bump -> %u\n", name_.c_str(), counter_);
        publishChannelChanged("Counter");
        const std::array<std::uint8_t, 4> bytes{
            static_cast<std::uint8_t>((counter_ >> 24) & 0xff),
            static_cast<std::uint8_t>((counter_ >> 16) & 0xff),
            static_cast<std::uint8_t>((counter_ >> 8) & 0xff),
            static_cast<std::uint8_t>(counter_ & 0xff)};
        result(iobject::ByteView(bytes.data(), bytes.size()));
        return true;
    }
    if (method == "SetText") {
        text_.assign(reinterpret_cast<const char*>(args.data()), args.size());
        std::fprintf(stderr, "[TestObject:%s] SetText -> \"%s\"\n", name_.c_str(), text_.c_str());
        publishChannelChanged("Text");
        result(iobject::ByteView());
        return true;
    }
    if (method == "PublishCustom") {
        const std::string type(reinterpret_cast<const char*>(args.data()), args.size());
        std::fprintf(stderr, "[TestObject:%s] PublishCustom(\"%s\")\n", name_.c_str(), type.c_str());
        if (self_ != nullptr) {
            self_->Publish(type, nullptr, false);
        }
        result(iobject::ByteView());
        return true;
    }
    return false;
}

void TestObject::publishChannelChanged(const std::string& channel) {
    if (self_ == nullptr) {
        return;
    }
    self_->Publish(iobject::RuntimeEventTypes::DataChannelChanged,
                   iobject::Runtime::make<iobject::DataChannelChangedEventData>(channel),
                   true);
}
