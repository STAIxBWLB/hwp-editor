/**
 * The two engine `capabilities().reason` samples the G-03-1 toolbar-geometry
 * harness toggles between, shared verbatim with
 * `apps/playground/e2e/toolbar-geometry.spec.ts` so the spec never re-types a
 * literal that could drift from what the page renders.
 *
 * Both are non-empty: the read-only notice, its `title` and the `": "` suffix
 * are present in BOTH measured samples, so reason LENGTH is the only variable
 * between the short and long toolbar measurements.
 *
 * Plain module on purpose — no "use client", no CSS import, nothing Node
 * cannot parse, because Playwright imports it outside the Next bundle.
 */

/** One clause: a valid single-row baseline. */
export const SHORT_REASON = "배포용 문서입니다.";

/**
 * 300+ characters, in the shape hwp-cli emits for a protected/distribution
 * document. Korean breaks between characters, so this is what collapses the
 * sibling toolbar controls to ~one glyph each before the fix.
 */
export const LONG_REASON =
  "이 문서는 배포용 문서로 지정되어 있어 편집할 수 없습니다. " +
  "배포용 문서에는 원본 작성자가 설정한 배포 제한이 적용되어 있으며, " +
  "본문 문단, 표, 글상자, 머리말과 꼬리말을 포함한 모든 요소의 수정이 차단됩니다. " +
  "편집을 진행하려면 원본 작성자에게 배포 제한 해제를 요청하거나, " +
  "배포 제한이 적용되지 않은 원본 파일을 다시 전달받아 열어야 합니다. " +
  "또한 문서에 쓰기 암호가 설정되어 있는 경우에는 암호를 먼저 해제한 뒤 " +
  "다시 시도해야 하며, 암호를 알 수 없는 경우에는 편집 기능을 사용할 수 없습니다. " +
  "읽기와 렌더링, 내보내기는 제한 없이 그대로 사용할 수 있습니다.";
