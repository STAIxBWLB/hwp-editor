import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DocumentHandle } from "@hwp-editor/core";
import { HwpEngineError } from "@hwp-editor/core";
import { HwpEditor } from "../src/HwpEditor.js";
import { clientYForPara, createMockEngine, makeEnvelope } from "./mock-engine.js";

afterEach(cleanup);

const file: DocumentHandle = {
  name: "minutes.hwpx",
  data: new TextEncoder().encode("original"),
};

beforeAll(() => {
  // jsdom reports zero-size boxes; give pages the render's 595x842 rect.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains("hwped-page")) {
      return {
        top: 0,
        left: 0,
        right: 595,
        bottom: 842,
        width: 595,
        height: 842,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return {
      top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

describe("HwpEditor edit flow", () => {
  it("render → click → select → queue op → Apply calls engine.edit", async () => {
    const engine = createMockEngine();
    const onChange = vi.fn();
    const onDirtyChange = vi.fn();
    render(
      <HwpEditor
        engine={engine}
        file={file}
        onChange={onChange}
        onDirtyChange={onDirtyChange}
      />,
    );

    const page = await screen.findByRole("button", { name: "페이지 1" });
    // Click near the top of the page selects the heading segment (para 0).
    fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), 0) });

    // The inspector shows the segment's plain text.
    await screen.findByText("1. 회의록");

    const input = screen.getByLabelText("텍스트 교체");
    fireEvent.change(input, { target: { value: "2. 회의록" } });
    fireEvent.click(screen.getByRole("button", { name: "교체" }));

    // Pending count appears; dirty callback fires.
    await screen.findByText("대기 편집 1");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "적용 (1)" }));

    await screen.findByText("대기 편집 0");
    expect(engine.calls.edit).toHaveLength(1);
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "replace", find: "1. 회의록", replace: "2. 회의록" },
    ]);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ name: "edited-1.hwpx" }),
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("applies queued ops on Cmd/Ctrl+Enter and clears selection on Escape", async () => {
    const engine = createMockEngine();
    const { container } = render(<HwpEditor engine={engine} file={file} />);

    const page = await screen.findByRole("button", { name: "페이지 1" });
    fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), 1) });
    await screen.findByText("2026년 8월 정기 회의");

    fireEvent.change(screen.getByLabelText("텍스트 교체"), {
      target: { value: "2026년 9월 정기 회의" },
    });
    fireEvent.click(screen.getByRole("button", { name: "교체" }));
    await screen.findByText("대기 편집 1");

    const root = container.firstElementChild;
    if (root === null) throw new Error("no root");
    fireEvent.keyDown(root, { key: "Enter", ctrlKey: true });
    await screen.findByText("대기 편집 0");
    expect(engine.calls.edit).toHaveLength(1);

    // Select again, then Escape clears the inspector back to the hint.
    fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), 1) });
    await screen.findByText("2026년 8월 정기 회의");
    fireEvent.keyDown(root, { key: "Escape" });
    await screen.findByText("페이지를 클릭해 편집할 문단을 선택하세요.");
  });
});

describe("HwpEditor protected documents", () => {
  it("shows a read-only notice and disables editing", async () => {
    const engine = createMockEngine({
      editable: false,
      reason: "배포용 문서",
    });
    render(<HwpEditor engine={engine} file={file} />);

    await screen.findByText("읽기 전용: 배포용 문서");
    const page = await screen.findByRole("button", { name: "페이지 1" });
    fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), 0) });
    await screen.findByText("1. 회의록");

    expect(screen.getByLabelText("텍스트 교체")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "교체" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /^적용/ })).toHaveProperty("disabled", true);
  });
});

describe("HwpEditor engine error states", () => {
  function failingEngine(message: string): ReturnType<typeof createMockEngine> {
    const engine = createMockEngine();
    engine.capabilities = async () => ({
      version: "0.8.8-test",
      editable: true,
      formats: ["hwp", "hwpx"],
    });
    engine.read = async () => {
      throw new Error(message);
    };
    engine.render = async () => {
      throw new Error(message);
    };
    return engine;
  }

  it("renders a timeout badge distinctly from other load failures", async () => {
    render(
      <HwpEditor
        engine={failingEngine("hwp-engine HTTP 504: hwp render timed out after 60000ms")}
        file={file}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("문서 열기 실패");
    expect(alert.getAttribute("data-error-kind")).toBe("timeout");
    expect(alert.textContent).toContain("엔진 시간 초과");
  });

  it("renders a binary-missing badge distinctly", async () => {
    render(
      <HwpEditor
        engine={failingEngine("hwp-engine HTTP 503: hwp binary not found: hwp")}
        file={file}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-error-kind")).toBe("unavailable");
    expect(alert.textContent).toContain("hwp 실행 파일 없음");
  });

  it("renders an edit-time protected refusal distinctly", async () => {
    const engine = createMockEngine();
    engine.edit = async () => {
      throw new Error(
        "hwp-engine HTTP 422: hwp edit failed: distribution (배포용) document",
      );
    };
    render(<HwpEditor engine={engine} file={file} />);

    const page = await screen.findByRole("button", { name: "페이지 1" });
    fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), 0) });
    await screen.findByText("1. 회의록");
    fireEvent.change(screen.getByLabelText("텍스트 교체"), {
      target: { value: "수정됨" },
    });
    fireEvent.click(screen.getByRole("button", { name: "교체" }));
    fireEvent.click(screen.getByRole("button", { name: "적용 (1)" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("편집 적용 실패");
    expect(alert.getAttribute("data-error-kind")).toBe("protected");
    expect(alert.textContent).toContain("보호/배포 문서");
  });

  it("renders unknown failures without a kind badge", async () => {
    render(
      <HwpEditor engine={failingEngine("hwp-engine HTTP 500: boom")} file={file} />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-error-kind")).toBe("generic");
    expect(alert.querySelector(".hwped-error-kind")).toBeNull();
  });

  it("selects the edit badge from the code when the prose has no marker", async () => {
    // Contains none of distribution / encrypted / protected / 배포용, so a
    // "protected" badge here can only have come from the code.
    const engine = createMockEngine();
    engine.edit = async () => {
      throw new HwpEngineError("protected", "이 문서는 편집할 수 없습니다");
    };
    render(<HwpEditor engine={engine} file={file} />);

    const page = await screen.findByRole("button", { name: "페이지 1" });
    fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), 0) });
    await screen.findByText("1. 회의록");
    fireEvent.change(screen.getByLabelText("텍스트 교체"), {
      target: { value: "수정됨" },
    });
    fireEvent.click(screen.getByRole("button", { name: "교체" }));
    fireEvent.click(screen.getByRole("button", { name: "적용 (1)" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("편집 적용 실패");
    expect(alert.getAttribute("data-error-kind")).toBe("protected");
  });

  it("issues exactly one render call when the load render rejects", async () => {
    // The deleted client-side SVG->PNG catch-all turned any render failure
    // into a second full CLI render and hid which error occurred (BUG-01).
    const engine = createMockEngine();
    let renders = 0;
    engine.render = async () => {
      renders += 1;
      throw new HwpEngineError("timeout", "hwp render timed out after 60000ms");
    };
    render(<HwpEditor engine={engine} file={file} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("문서 열기 실패");
    expect(alert.getAttribute("data-error-kind")).toBe("timeout");
    expect(renders).toBe(1);
  });

  it("selects the badge from the error code, not from the message prose", async () => {
    // The message deliberately contains none of the classifyEngineError
    // substring markers: a "timeout" badge here can only come from the code.
    const engine = createMockEngine();
    engine.capabilities = async () => {
      throw new HwpEngineError("timeout", "무언가 잘못되었습니다");
    };
    render(<HwpEditor engine={engine} file={file} />);

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-error-kind")).toBe("timeout");
    expect(alert.textContent).toContain("엔진 시간 초과");
  });
});

describe("HwpEditor revert", () => {
  it("restores the snapshot taken before the applied edit", async () => {
    const engine = createMockEngine();
    const onChange = vi.fn();
    render(<HwpEditor engine={engine} file={file} onChange={onChange} />);

    const page = await screen.findByRole("button", { name: "페이지 1" });
    fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), 0) });
    await screen.findByText("1. 회의록");
    fireEvent.change(screen.getByLabelText("텍스트 교체"), {
      target: { value: "수정됨" },
    });
    fireEvent.click(screen.getByRole("button", { name: "교체" }));
    fireEvent.click(await screen.findByRole("button", { name: "적용 (1)" }));
    await screen.findByText("대기 편집 0");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "edited-1.hwpx" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(file);
    });
  });
});

describe("HwpEditor compose flow", () => {
  it("preset picker + guided form builds DocumentSpec v2 and opens the result", async () => {
    const engine = createMockEngine();
    const onChange = vi.fn();
    render(<HwpEditor engine={engine} file={null} onChange={onChange} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "새 문서 만들기" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "새 문서 만들기" });

    fireEvent.click(
      await screen.findByRole("radio", { name: "보고서" }),
    );
    fireEvent.change(screen.getByLabelText("제목"), {
      target: { value: "테스트 보고서" },
    });
    fireEvent.change(screen.getByLabelText("작성자"), {
      target: { value: "이영준" },
    });
    fireEvent.change(screen.getByLabelText("본문"), {
      target: { value: "# 1. 개요\n\n본문 내용입니다." },
    });
    fireEvent.click(screen.getByRole("button", { name: "문서 생성" }));

    await vi.waitFor(() => {
      expect(engine.calls.compose).toHaveLength(1);
    });
    const call = engine.calls.compose[0]!;
    expect(call.name).toBe("테스트 보고서.hwpx");
    expect(call.spec.version).toBe("2.0");
    expect(call.spec.document.metadata?.title).toBe("테스트 보고서");
    expect(call.spec.document.sections[0]?.page_number).toBeDefined();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ name: "테스트 보고서.hwpx" }),
    );

    // The composed document is opened: dialog closed, title in the toolbar.
    await vi.waitFor(() => {
      expect(dialog.isConnected).toBe(false);
    });
    await screen.findByText("테스트 보고서.hwpx");
    cleanup();
  });

  /** Drive the dialog to a compose() call on `engine`; returns the dialog. */
  async function driveCompose(
    engine: ReturnType<typeof createMockEngine>,
  ): Promise<HTMLElement> {
    render(<HwpEditor engine={engine} file={null} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "새 문서 만들기" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "새 문서 만들기" });
    fireEvent.change(screen.getByLabelText("제목"), {
      target: { value: "테스트" },
    });
    fireEvent.click(screen.getByRole("button", { name: "문서 생성" }));
    return dialog;
  }

  it("badges a protected compose refusal from its code", async () => {
    const engine = createMockEngine();
    engine.compose = async () => {
      throw new HwpEngineError("protected", "이 문서는 생성할 수 없습니다");
    };
    const dialog = await driveCompose(engine);

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("문서 생성 실패");
    expect(alert.getAttribute("data-error-kind")).toBe("protected");
    cleanup();
  });

  it("degrades a codeless compose failure to the generic kind", async () => {
    const engine = createMockEngine();
    engine.compose = async () => {
      throw new Error("boom");
    };
    const dialog = await driveCompose(engine);

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("문서 생성 실패: boom");
    expect(alert.getAttribute("data-error-kind")).toBe("generic");
    expect(alert.querySelector(".hwped-error-kind")).toBeNull();
    cleanup();
  });
});

describe("HwpEditor table flow", () => {
  it("selecting a table segment opens the grid; set-cell queues the CLI coords", async () => {
    const engine = createMockEngine();
    render(<HwpEditor engine={engine} file={file} />);

    const page = await screen.findByRole("button", { name: "페이지 1" });
    fireEvent.click(page, { clientY: clientYForPara(makeEnvelope(), 2) });

    // Auto-switched to the table tab with the parsed grid.
    const cell = await screen.findByRole("button", { name: "예산" });
    fireEvent.click(cell);

    fireEvent.change(screen.getByLabelText(/셀 \(1, 0\)/), {
      target: { value: "예산안" },
    });
    fireEvent.click(screen.getByRole("button", { name: "셀 설정" }));

    await screen.findByText("대기 편집 1");
    fireEvent.click(screen.getByRole("button", { name: "적용 (1)" }));
    await screen.findByText("대기 편집 0");
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "set-cell", table: 0, row: 1, col: 0, value: "예산안" },
    ]);
  });
});

describe("HwpEditor fields flow", () => {
  it("lists {{field}} slots, jumps to the segment, and queues set-field", async () => {
    const engine = createMockEngine();
    render(<HwpEditor engine={engine} file={file} />);

    await screen.findByRole("button", { name: "페이지 1" });
    fireEvent.click(screen.getByRole("tab", { name: "필드" }));

    // Jump-to selects the containing segment.
    fireEvent.click(await screen.findByRole("button", { name: "date" }));
    await screen.findByText(/다음 회의는/);

    fireEvent.click(screen.getByRole("tab", { name: "필드" }));
    fireEvent.change(screen.getByLabelText("필드 date 값"), {
      target: { value: "9월 1일" },
    });
    fireEvent.click(screen.getByRole("button", { name: "설정" }));

    await screen.findByText("대기 편집 1");
    fireEvent.click(screen.getByRole("button", { name: "적용 (1)" }));
    await screen.findByText("대기 편집 0");
    expect(engine.calls.edit[0]?.ops).toEqual([
      { kind: "set-field", name: "date", value: "9월 1일" },
    ]);
  });
});
