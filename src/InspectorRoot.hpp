#pragma once

#include <iobject/IRuntimeObject.hpp>
#include <iobject/Logger.hpp>

// 应用根节点：组合运行时内置的 Logger，并把鸭子类型钩子转发给 Logger。
// 用法：iobject::RuntimeDomain domain(iobject::Runtime::make<InspectorRoot>());
class InspectorRoot {
public:
    /// 标记：转发到线程安全的 Logger，叶子操作可跨线程。
    static constexpr bool kThreadSafe = true;

    // ---- IObject 鸭子类型钩子：转发给组合的 Logger ----
    void BindRuntime(iobject::IRuntimeObject* self) { m_logger.BindRuntime(self); }

    bool WriteData(iobject::DataChannelView channel, iobject::ByteInput data) {
        return m_logger.WriteData(channel, data);
    }

    bool ReadData(iobject::DataChannelView channel, iobject::DataReceiver receiver) const {
        return m_logger.ReadData(channel, receiver);
    }

    bool Invoke(iobject::MethodView method, iobject::ByteInput args, iobject::DataReceiver result) {
        return m_logger.Invoke(method, args, result);
    }

private:
    iobject::Logger m_logger;
};
