// duet unstick: releases injected touch pointers that another tool pressed and never let go.
//
// Android's input dispatcher checks that injected touches are consistent. If an automation tool
// is killed mid-gesture, its pointer stays "down" and every later injected tap is rejected
// ("pointers already down"), while `adb shell input tap` still exits 0. `input` always uses
// pointer id 0, so it cannot release another id. This sends ACTION_CANCEL for the given ids.
//
// Run on the device:  CLASSPATH=/data/local/tmp/duet-unstick.dex app_process / Unstick <deviceId> <pointerId>...
// Build:              scripts/build-unstick.sh

import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.MotionEvent;
import java.lang.reflect.Method;

public class Unstick {
  public static void main(String[] args) throws Exception {
    if (args.length < 2) {
      System.out.println("usage: Unstick <deviceId> <pointerId>...");
      System.exit(2);
    }
    int deviceId = Integer.parseInt(args[0]);
    int count = args.length - 1;
    MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[count];
    MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[count];
    for (int i = 0; i < count; i++) {
      props[i] = new MotionEvent.PointerProperties();
      props[i].id = Integer.parseInt(args[i + 1]);
      props[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
      coords[i] = new MotionEvent.PointerCoords();
      coords[i].x = 1;
      coords[i].y = 1;
      coords[i].pressure = 1;
      coords[i].size = 1;
    }
    long now = SystemClock.uptimeMillis();
    MotionEvent cancel = MotionEvent.obtain(now, now, MotionEvent.ACTION_CANCEL, count, props, coords, 0, 0, 1f, 1f,
        deviceId, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);

    // InputManagerGlobal on Android 14+, InputManager before that. Both are hidden APIs.
    Class<?> cls;
    Object manager;
    try {
      cls = Class.forName("android.hardware.input.InputManagerGlobal");
      manager = cls.getMethod("getInstance").invoke(null);
    } catch (ClassNotFoundException e) {
      cls = Class.forName("android.hardware.input.InputManager");
      manager = cls.getMethod("getInstance").invoke(null);
    }
    Method inject = cls.getMethod("injectInputEvent", InputEvent.class, int.class);
    boolean ok = (Boolean) inject.invoke(manager, cancel, 0 /* INJECT_INPUT_EVENT_MODE_ASYNC */);
    System.out.println(ok ? "injected" : "rejected");
  }
}
