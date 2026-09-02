# Decision Packet: Dark terminal surface

**의도**: 밝은 Paseo 인터페이스에서도 터미널 출력이 어두운 배경과 고대비 ANSI 색상으로 읽히게 한다.
**완료기준**: 밝은 테마의 터미널 배경이 canonical dark terminal 배경을 사용하고, 어두운 테마의 사용자 팔레트는 유지되며, 대상 단위시험·타입검사·린트·실제 렌더 확인이 통과한다.
**범위**: 터미널 팔레트 선택과 회귀시험. 전체 앱 테마, 에이전트 메시지 UI, 배포는 제외한다.
**위험**: 사용자 지정 밝은 테마의 터미널 팔레트가 어두운 canonical 팔레트로 대체된다.
**역할 제안**: m1이 UI 선택 로직과 화면 검증, m3이 회귀시험을 담당한다.
**운영 표면**: none
**Authority packet**: none — source-only client styling, no runtime or external writer change
**Authority validator**: not applicable

## Applied Memory Trace

- refs: Paseo official-release verification boundary
- decision effect: source와 실제 렌더 성공을 공식 설치 해결과 분리해 보고한다.
- prevented risk: 소스 수정만으로 현재 설치본이 고쳐졌다고 과장하지 않는다.
- worker memory pack: paseo-source-vs-release

# PRD: Dark terminal surface

## Overview

Paseo의 인터페이스 테마와 터미널 색상 결정을 분리한다. 밝은 인터페이스에서는 canonical dark terminal 팔레트를 사용하고, 이미 어두운 인터페이스에서는 선택한 테마의 터미널 팔레트를 유지한다.

## Success criteria

- Light theme terminal background equals the built-in dark terminal background.
- Light theme terminal foreground and ANSI colors come from the same dark palette.
- Dark theme and custom dark theme terminal palettes remain unchanged.
- Targeted test, typecheck, lint, and rendered browser evidence pass.

## Scope

### In scope

- Terminal pane xterm palette resolution.
- Unit regression coverage.
- Browser-rendered terminal visual check.

### Out of scope

- Global app theme changes.
- Release, production daemon restart, or installed Desktop replacement.
- New Appearance setting.

## User story

As a Paseo user, I want terminal output on a dark surface even when the surrounding app is light so that ANSI-colored text remains readable.

## Non-functional requirements

- Same behavior on web, Electron, iOS, and Android through the shared terminal pane.
- No terminal transport, input, resize, or snapshot behavior change.

## Edge cases and risks

- Custom light themes intentionally defining a light terminal will receive the canonical dark terminal palette.
- Custom dark themes must retain their own terminal colors.

## ADR-1: Dark terminal only under light UI

- **Context:** Light UI colors produce a white xterm background and low-contrast CLI output.
- **Decision:** Resolve the terminal palette by color scheme: canonical dark palette for light themes, active palette for dark themes.
- **Consequences:** The surrounding interface stays light; terminal readability is stable; dark theme customization remains intact.

## Implementation chunks

### CHUNK-1 Regression test [m3]

- Modify: `packages/app/src/utils/to-xterm-theme.test.ts`
- RED: assert that light UI resolves to the canonical dark terminal palette and dark UI preserves its palette.
- Accepted: test fails before implementation.

### CHUNK-2 Palette resolver [m1]

- Modify: `packages/app/src/utils/to-xterm-theme.ts`
- Modify: `packages/app/src/components/terminal-pane.tsx`
- GREEN: add one shared theme-to-xterm resolver and wire the terminal pane to it.
- Accepted: targeted test passes without terminal behavior changes.

### CHUNK-3 Verification [m1]

- Run targeted test, typecheck, lint, and formatting checks.
- Render a light-interface terminal and visually confirm dark background plus readable ANSI colors.
- Accepted: checks and screenshot evidence pass.

## Spec Blueprint Summary

- **Total chunks:** 3
- **Role allocation:** m1=2, m2=0, m3=1
- **Dependency chain:** CHUNK-1 → CHUNK-2 → CHUNK-3
- **Verification gate:** targeted Vitest + typecheck + lint + browser screenshot
