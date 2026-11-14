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

/**
 * Pinned to agent-hwp v1.6.2:
 * crates/hwp-cli/src/commands/edit.rs:2269-2284 and :3086-3094;
 * crates/hwp-convert/src/address.rs:120 (NoSuchPath), :256-261 (descend).
 * https://github.com/STAIxBWLB/agent-hwp/blob/v1.6.2/crates/hwp-convert/src/address.rs#L120
 * describe_address omits chars, so both whole-run and chars requests print this.
 */
export const UNRESOLVABLE_ADDRESS =
  "Error: 주소를 해석할 수 없는 편집 연산이 있습니다:\n" +
  "op[0] id b800fb2a253cdfb9.0.0.7.0.0 — 주소가 가리키는 위치를 문서에서 찾을 수 없습니다";

/**
 * Captured from the released ahwp v2.0.0 aarch64-apple-darwin binary, without
 * --verify: `ahwp edit font-type-info.hwpx -o font-refused.hwp --set-meta title=x`.
 * Input: `ahwp new -o font-base.hwpx`, then add one child to the first
 * HANGUL font in Contents/header.xml:
 * `<hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0"
 * strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>`.
 * Only the first Error: line is a classifier input; the cause list below
 * demonstrates why the font code must not choose a more specific class.
 */
export const FONT_TYPE_INFO = `메타데이터 설정: "title=x"
Error: 출력 검증 실패 (대상: font-refused.hwp)

Caused by:
    edit: 보존 불가 데이터 1건을 제거하거나 변경할 수 없어 출력을 게시하지 않습니다
      - font_type_info_unrepresentable: 1 item(s)
    해결: 글꼴 분류 정보의 HWP5 변환 매핑이 확인되지 않았습니다. 원본 정보를 보존하려면 .hwpx 형식을 유지하세요. 손실을 수용하려면 ahwp convert를 --strict 없이 실행하거나 MCP hwp_convert에 strict: false를 지정해 .hwpx 입력을 먼저 .hwp로 변환한 뒤, 변환된 파일로 ahwp edit 또는 MCP hwp_edit를 다시 실행하세요.
`;
