#pragma once

#include <iobject/IRuntimeObject.hpp>

#include <cstdint>
#include <string>

/// 远程调试用的测试对象：暴露数据通道、方法，并在通道写入时发布 DataChannelChanged。
/// 用法：iobject::Runtime::make<TestObject>("Name") 包装成运行时节点后 Connect 到根节点。
///
/// 数据通道：
///   - "State"   1 字节（0/1）
///   - "Counter" 4 字节大端 uint32
///   - "Text"    变长 UTF-8 字符串
/// 方法（Invoke）：
///   - "Echo"          原样返回 args
///   - "Toggle"        翻转 State，发布 DataChannelChanged("State")，返回 1 字节新状态
///   - "Bump"          Counter 自增，发布 DataChannelChanged("Counter")，返回 4 字节大端新值
///   - "SetText"       用 args 设置 Text，发布 DataChannelChanged("Text")
///   - "PublishCustom" 以 args（事件类型名字符串）发布一个自定义事件（无载荷）
class TestObject {
public:
    /// 标记：ReadData/WriteData/Invoke 线程安全，跳过线程亲和断言（调试用）。
    static constexpr bool kThreadSafe = true;

    explicit TestObject(std::string name);
    ~TestObject();

    TestObject(const TestObject&) = delete;
    TestObject& operator=(const TestObject&) = delete;

    /// 框架在节点构造/析构时回调：记录自身节点指针（用于 Publish）。
    void BindRuntime(iobject::IRuntimeObject* self);

    bool ReadData(iobject::DataChannelView channel, iobject::DataReceiver receiver) const;
    bool WriteData(iobject::DataChannelView channel, iobject::ByteInput data);
    bool Invoke(iobject::MethodView method, iobject::ByteInput args, iobject::DataReceiver result);

private:
    void publishChannelChanged(const std::string& channel);

    std::string name_;
    iobject::IRuntimeObject* self_ = nullptr;
    std::uint8_t state_ = 1;     // "State"
    std::uint32_t counter_ = 5;  // "Counter"
    std::string text_;           // "Text"
};
