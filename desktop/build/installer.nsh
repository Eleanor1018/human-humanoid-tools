!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
Var GvhmrCheckbox
Var GvhmrRequested

; LCIDs are used directly because electron-builder includes this file before
; the symbolic NSIS language constants are available to custom scripts.
LangString GvhmrPageTitle 1033 "Optional video-to-motion"
LangString GvhmrPageTitle 2052 "可选的视频转动作组件"
LangString GvhmrPageSummary 1033 "The core GUI, retargeting tools, sample motions, and bundled robots work without GVHMR."
LangString GvhmrPageSummary 2052 "核心 GUI、动作重映射工具、示例动作和内置机器人均可在未安装 GVHMR 时使用。"
LangString GvhmrPageCheckbox 1033 "Configure GVHMR video-to-motion after installation"
LangString GvhmrPageCheckbox 2052 "安装完成后配置 GVHMR 视频转动作组件"
LangString GvhmrPageDetails 1033 "GVHMR remains separate because it requires Docker Desktop, licensed SMPL-X files, and roughly 22 GB of additional images and weights. Selecting this option opens the setup section in hhtools on first launch; it does not silently accept third-party licences."
LangString GvhmrPageDetails 2052 "GVHMR 作为可选组件单独安装，因为它需要 Docker Desktop、获得许可的 SMPL-X 文件，以及约 22 GB 的额外镜像和权重。选择此项后，hhtools 会在首次启动时打开配置页面；程序不会代替用户接受第三方许可协议。"

!macro customPageAfterChangeDir
  Page custom GvhmrPageCreate GvhmrPageLeave
!macroend

Function GvhmrPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 18u "$(GvhmrPageTitle)"
  Pop $0
  ${NSD_CreateLabel} 0 24u 100% 30u "$(GvhmrPageSummary)"
  Pop $0
  ${NSD_CreateCheckbox} 0 62u 100% 24u "$(GvhmrPageCheckbox)"
  Pop $GvhmrCheckbox
  ${NSD_SetState} $GvhmrCheckbox ${BST_UNCHECKED}
  ${NSD_CreateLabel} 16u 90u 94% 52u "$(GvhmrPageDetails)"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function GvhmrPageLeave
  ${NSD_GetState} $GvhmrCheckbox $GvhmrRequested
FunctionEnd

!macro customInstall
  ${If} $GvhmrRequested == ${BST_CHECKED}
    CreateDirectory "$LOCALAPPDATA\hhtools\installer"
    FileOpen $0 "$LOCALAPPDATA\hhtools\installer\gvhmr.requested" w
    FileWrite $0 "requested"
    FileClose $0
  ${EndIf}
!macroend
!endif
