#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstdint>

// AppKit has physical gesture boundaries even when Chromium consumes the wheel
// event and never emits gestureScrollBegin. Observe only this application's
// events, pass them through unchanged, and keep JavaScript out of the monitor.
struct ScrollState {
  id monitor = nil;
  uint32_t generation = 0;
};

static void Cleanup(void *data) {
  auto *state = static_cast<ScrollState *>(data);
  if (state->monitor) [NSEvent removeMonitor:state->monitor];
  delete state;
}

static napi_value Generation(napi_env env, napi_callback_info info) {
  void *data;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data);
  napi_value result;
  napi_create_uint32(env, static_cast<ScrollState *>(data)->generation, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  auto *state = new ScrollState();
  state->monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel handler:^NSEvent *(NSEvent *event) {
    if ((event.phase & NSEventPhaseBegan) && event.momentumPhase == NSEventPhaseNone) ++state->generation;
    return event;
  }];
  napi_add_env_cleanup_hook(env, Cleanup, state);
  napi_value generation;
  napi_create_function(env, "generation", NAPI_AUTO_LENGTH, Generation, state, &generation);
  napi_set_named_property(env, exports, "generation", generation);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
