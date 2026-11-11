/**
 * hwp-cli v1.6.1 stderr for the classified edit refusals, shared by the core,
 * Tauri and server tests so every transport is checked against the same lines.
 */
export const UNMATCHED =
  "Error: 적용되지 않은 편집 요청이 있습니다: " +
  'replace address=0.1 from="없는 텍스트" to="{{owner}}" ' +
  "(--allow-partial로 일치한 요청만 적용 가능)";

export const RANGE_TAG =
  "Error: 미해석 PARA_RANGE_TAG 구간 표시가 있어 WCHAR 위치가 바뀌거나 표시를 잃는 문단 재작성을 지원하지 않습니다. " +
  "같은 WCHAR 길이의 텍스트 치환을 사용하거나 한글에서 구간 표시를 제거한 파일로 다시 실행하세요.";

export const RUN_CONFLICT =
  "Error: 주소 지정 편집이 서로 충돌합니다:\nop[0]이 문단 0.1의 길이를 바꿀 수 있어 op[1]의 고정된 run 범위가 무효화됩니다";

export const DRIFT =
  "Error: set_format 주소 [0, 2)의 문단은 앞선 연산(set_indent_level, replace 등)으로 글자 수가 5에서 9(으)로 바뀌어 " +
  "범위가 다른 글자를 가리킵니다. 아무것도 쓰지 않았습니다. 연산 순서를 바꿔 set_format을 앞에 두거나 별도 편집으로 나누어 실행하세요";

/** A Removal and a LengthChange in one list: the run-range step would clear only one. */
export const MIXED_CONFLICT =
  "Error: 주소 지정 편집이 서로 충돌합니다:\n" +
  "op[0]이 문단 0.1을(를) 제거하여 op[1]이 같은 주소(또는 그 하위 경로)를 가리킬 수 없습니다\n" +
  "op[2]이 문단 0.2의 길이를 바꿀 수 있어 op[3]의 고정된 run 범위가 무효화됩니다";

/** An unapplied hyperlink whose user values carry every matched token. */
export const ECHOED_UNAPPLIED =
  "Error: 적용되지 않은 편집 요청이 있습니다: " +
  'create_hyperlink anchor="미해석 PARA_RANGE_TAG 구간 표시가 있어 WCHAR 위치가 바뀌거나" ' +
  'url="https://x/범위가 다른 글자를 가리킵니다. 고정된 run 범위가 무효화됩니다" ' +
  "(--allow-partial로 일치한 요청만 적용 가능)";
