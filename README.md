# oh-my-ghcp

[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)(OMC)를 **수정 없이** GitHub Copilot CLI에서
실행합니다. ralph, autopilot, ralplan, deep-interview 같은 OMC 스킬과 에이전트, 훅, MCP 상태 도구, `omc` CLI를
그대로 쓰고, Claude Code와 Copilot CLI의 차이는 이 저장소의 얇은 어댑터가 맞춥니다.

> [!NOTE]
> 비공식 프로젝트입니다. OMC 작성자나 GitHub과 관련이 없습니다. OMC 작성자는 Copilot CLI 지원을 OMC 본체가 아니라
> 별도의 실험적 하네스로 먼저 시도하는 것이 맞다고 정리했고
> ([Yeachan-Heo/oh-my-claudecode#2651](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/2651)), 이 저장소가
> 그런 별도 하네스입니다.

[English](#english) · [설계](docs/DESIGN.md) · [검증 결과](docs/VERIFICATION.md)

## 동작 방식

- Copilot CLI는 Claude Code 형식의 플러그인 디렉터리를 `--plugin-dir`로 읽습니다. 설치 스크립트가
  [`upstream.json`](upstream.json)에 고정된 OMC 공식 릴리스(v5.6.1)를 받아 Copilot용 플러그인을 만듭니다. OMC
  소스는 이 저장소에 들어 있지 않습니다.
- 모든 OMC 훅은 `adapter/ghcp-shim.cjs`를 거쳐 실행됩니다. 훅 실행 위치, 도구와 스킬 이름, 컨텍스트 전달 방식,
  서브에이전트 세션, 모델 이름의 차이를 이 shim이 맞춥니다.
- ralph 같은 지속 모드는 Claude Code에서처럼 OMC의 Stop 훅으로 이어집니다. 작업이 끝나지 않았으면 Stop 훅이 종료를
  막고, 그 이유가 다음 프롬프트로 모델에 전달됩니다.

## 요구 사항

- GitHub Copilot CLI 1.0.91 이상(이 버전으로 검증)
- Node.js 20 이상, npm, git
- Windows(Windows PowerShell 5.1, PowerShell 7), Linux, WSL. macOS는 아직 테스트하지 않았습니다.

## 설치

Windows:

```powershell
git clone https://github.com/EON-LEE/ohmyghcp.git
cd ohmyghcp
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
```

설치 스크립트가 `copilot-omc`와 `omc` 명령을 사용자 PATH에 추가합니다. 새 터미널을 열어서 쓰세요.

Linux, WSL, macOS:

```sh
git clone https://github.com/EON-LEE/ohmyghcp.git
cd ohmyghcp
sh scripts/install.sh
export PATH="$HOME/.copilot/oh-my-ghcp/bin:$PATH"   # ~/.bashrc 또는 ~/.zshrc에도 추가
```

모든 파일은 `~/.copilot/oh-my-ghcp` 아래에 설치됩니다(`COPILOT_HOME`을 설정했다면 그 아래). Copilot CLI 설정과
Claude Code의 `~/.claude`는 바꾸지 않습니다.

| Windows (`install.ps1`) | Linux, macOS (`install.sh`) | 설명 |
| --- | --- | --- |
| `-TaskModel <model>` | `--task-model <model>` | 모든 서브에이전트(task 도구)의 모델 고정 |
| `-TaskModelMap "opus=...,sonnet=...,haiku=..."` | `--task-model-map <map>` | OMC의 Claude 등급을 Copilot 모델로 매핑 |
| `-AgentModel <model>` | `--agent-model <model>` | OMC 에이전트 정의에 모델 지정 |
| `-OmcRef <tag>` | `--omc-ref <tag>` | 고정 릴리스 대신 다른 OMC 태그나 브랜치 설치(커밋 검증 안 함) |
| `-RebuildCli` | `--rebuild-cli` | OMC CLI 번들 재빌드(OMC v5.6.0에서만 필요) |
| `-Force` | `--force` | OMC를 다시 받고 의존성 재설치 |
| `-NoPath` | | 사용자 PATH를 바꾸지 않음 |
| `-Uninstall` | `--uninstall` | 제거 |

## 사용법

```powershell
copilot-omc                                                 # OMC가 붙은 Copilot CLI
copilot-omc --model gpt-5-mini                              # copilot 옵션은 모두 그대로 사용
copilot-omc -p "ralph: make the failing tests pass" --allow-all
```

`copilot-omc`는 `copilot --plugin-dir <플러그인>`을 실행합니다. 평소 쓰는 `copilot`에는 영향이 없습니다. Copilot
CLI 1.0.91의 `copilot plugin install`은 로컬 디렉터리를 받지 않아서 런처를 씁니다.

프롬프트에 키워드를 넣으면 OMC 모드가 켜집니다.

| 모드 | 프롬프트 예 |
| --- | --- |
| ralph: 완료와 검증까지 반복 | `ralph: 실패하는 테스트 고쳐줘`, `랄프 실행: 실패하는 테스트 고쳐줘` |
| autopilot: 요구사항부터 구현, 검증까지 | `autopilot: 할 일 관리 CLI 만들어줘`, `오토파일럿으로 할 일 관리 CLI 만들어줘` |
| ralplan: 합의형 계획 | `ralplan: 인증 모듈 리팩터링 계획 세워줘`, `랄플랜으로 ...` |
| deep-interview: 요구사항 인터뷰 | `딥인터뷰로 요구사항부터 정리해줘`, `deep interview: build a todo CLI` |
| ultragoal | `use ultragoal to ship the release checklist`, `$ultragoal ...` |
| 보조 모드 | `ultrathink: ...`, `tdd: ...`, `코드 리뷰 해줘`, `security review 해줘`, `deepsearch: ...` |
| 실행 중인 모드 중지 | `cancelomc` 또는 `stopomc` |

- 한국어 `랄프`는 바로 뒤에 `실행`, `시작`, `켜줘`, `돌려줘` 같은 말이 와야 켜집니다. `랄프:`나 `랄프로 ...`는
  켜지지 않습니다.
- 키워드를 묻는 문장(`ralph가 뭐야?`)은 OMC가 일부러 무시합니다.
- 프롬프트를 `!`로 시작하면 Copilot이 셸 명령으로 실행하니 키워드 앞에 `!`를 붙이지 마세요.

### 모델과 사용량

- 서브에이전트(task 도구)는 기본적으로 세션 모델(`--model`)로 실행되고, OMC가 붙이는 Claude 등급(`opus`, `sonnet`,
  `haiku`)은 무시합니다. 다만 메인 에이전트가 task 호출에 Copilot 모델을 직접 넣으면 그 모델로 실행됩니다(테스트에서
  gpt-5-mini 세션이 architect 서브에이전트에 `gpt-5.4`를 넣었습니다). 서브에이전트 모델을 고정하려면
  `GHCP_TASK_MODEL=<model>` 환경 변수(`off`면 해제)나 위의 설치 옵션을 쓰세요.
- ralph, autopilot, ultragoal은 프롬프트 하나로 여러 턴을 실행하므로 일반 대화보다 사용량이 많습니다. 처음에는
  `--model gpt-5-mini`와 `GHCP_TASK_MODEL=gpt-5-mini`처럼 가벼운 모델로 시험해 보세요. 테스트에서 이렇게 작은 ralph
  작업을 한 번 실행할 때 프리미엄 요청은 0건이었고 AI 크레딧은 약 4~10 AIC가 들었습니다(서브에이전트를 부르거나
  ralph가 반복하면 늘어납니다). 사용량은 Copilot CLI 상태 표시줄(`Session: N AIC used`)에서 확인할 수 있습니다.

### 상태 파일

| 위치 | 내용 |
| --- | --- |
| `<프로젝트>/.omc/` | OMC 프로젝트 상태(모드 상태, 계획, 로그). 커밋하지 않으려면 `.gitignore`에 추가하세요. |
| `~/.copilot/oh-my-ghcp/` | OMC 체크아웃, 생성된 플러그인, 명령, shim 상태, OMC의 `CLAUDE_CONFIG_DIR` |
| `~/.omc/` | OMC 전역 디렉터리. Claude Code용 OMC와 함께 씁니다. |

## 업데이트와 제거

```powershell
git pull
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1      # sh scripts/install.sh
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall   # sh scripts/install.sh --uninstall
```

다시 설치하면 플러그인을 새로 만들고(고정된 OMC 버전이 바뀌었으면 OMC도 새로 받습니다) OMC 상태는 유지합니다.
Windows에서는 oh-my-ghcp를 쓰는 Copilot 세션을 먼저 닫으세요. 제거해도 각 프로젝트의 `.omc/`는 남습니다.

## 제한 사항

- 실제 Copilot CLI(1.0.91) 실행은 Windows에서 검증했습니다. Linux(WSL)에서는 설치 스크립트와 오프라인 훅 테스트까지만
  검증했습니다. 자세한 내용은 [검증 결과](docs/VERIFICATION.md)를 보세요.
- 실제 모델로 처음부터 끝까지 검증한 것은 ralph입니다. 다른 모드는 위 표의 예시 프롬프트로 모드가 시작되는
  단계(키워드 감지, 스킬 호출 안내, OMC가 만드는 모드 상태)와 ultragoal의 `/goal` 가드 우회까지만 오프라인 테스트로
  확인했습니다.
- `omc team`(tmux 작업자), HUD와 상태 표시줄, VS Code의 Copilot은 다루지 않습니다.
- Windows에서는 OMC의 SessionEnd 훅이 OMC가 정한 시간 제한(300ms)을 넘기는 경우가 많아서 세션을 끝낼 때 모드
  상태가 대부분 정리되지 않습니다. 끝내기 전에 `cancelomc`로 모드를 끄세요.
- 지속 모드는 여러 도구 호출을 사람 확인 없이 실행할 수 있습니다. `--allow-all`이나 `--yolo`는 신뢰하는 저장소에서만
  쓰세요.
- 작은 모델은 같은 스킬을 반복해서 부르거나 `.omc/`를 커밋하기도 합니다.

## 라이선스

이 저장소는 MIT 라이선스입니다([LICENSE](LICENSE)). OMC도 MIT 라이선스(Copyright (c) 2025 Yeachan Heo)이며, 설치할
때 원본을 받아옵니다. 자세한 내용은 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)를 보세요.

## English

oh-my-ghcp runs [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) unmodified on GitHub Copilot CLI
(verified end to end with Copilot CLI 1.0.91 on Windows; on Linux/WSL the installer and the offline hook tests pass).
It is unofficial and not affiliated with OMC's author or GitHub.

- Install: `scripts\install.ps1` (Windows) or `sh scripts/install.sh` (Linux, WSL; macOS is untested). Requires
  Node.js 20+, npm and git.
- Use: start `copilot-omc` (all `copilot` options work), then prompt with `ralph: ...`, `autopilot: ...`,
  `ralplan: ...`, `deep interview: ...` or `use ultragoal to ...`. `cancelomc` stops a running mode.
- Subagents run on the session model unless the task call names a Copilot model (in our test a gpt-5-mini session
  asked for `gpt-5.4`); OMC's Claude tiers are dropped. Set `GHCP_TASK_MODEL` or the installer's task-model options to
  pin them. Persistent modes run several turns per prompt; try a light model such as `gpt-5-mini` first, for the
  session and the subagents.

How it works: [docs/DESIGN.md](docs/DESIGN.md). Test results: [docs/VERIFICATION.md](docs/VERIFICATION.md).
