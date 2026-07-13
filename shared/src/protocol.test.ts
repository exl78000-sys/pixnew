import { describe, expect, it } from "vitest";
import { parseClientMessage, simTimeToClock } from "./protocol";

describe("simTimeToClock", () => {
  it("換算第 1 天 07:00", () => {
    const c = simTimeToClock(7 * 60, 1);
    expect(c).toMatchObject({ day: 1, hhmm: "07:00", speed: 1 });
  });

  it("跨日換算", () => {
    const c = simTimeToClock(1440 + 90, 4);
    expect(c).toMatchObject({ day: 2, hhmm: "01:30", speed: 4 });
  });
});

describe("parseClientMessage", () => {
  it("解析合法訊息", () => {
    expect(parseClientMessage('{"type":"set_speed","speed":4}')).toEqual({
      type: "set_speed",
      speed: 4
    });
  });

  it("拒絕壞 JSON 與缺 type", () => {
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage('{"foo":1}')).toBeNull();
  });
});
