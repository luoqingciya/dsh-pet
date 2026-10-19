; dsh-petNG 安装包（NSIS）自定义脚本
;
; ── 为什么需要它：升级会丢配置 ──────────────────────────────────────────────
;
; 用户数据（配置 / 密钥 / 记忆 / 自定义动画）按设计就在 `<安装目录>\data`。
; 而 electron-builder 的 NSIS 在**升级**时的默认行为是：
;
;   un.atomicRMDir  →  把整个 $INSTDIR 挪进 $PLUGINSDIR\old-install
;   RMDir /r $INSTDIR
;
; $PLUGINSDIR 是卸载器的临时目录，卸载器一退出就被删 —— 于是 `data\` 连同配置一起没了。
; 这不是"用户手滑"，是安装器的既定流程（见 app-builder-lib/templates/nsis/uninstaller.nsh）。
;
; ── 做法 ────────────────────────────────────────────────────────────────────
;
;   1. `customInit`（.onInit 里，**早于**旧版卸载器被调用）把 data 挪到安装目录**同级**；
;   2. `customInstall`（文件装完之后）再挪回 `$INSTDIR\data`。
;
; 同盘 rename，秒级、不复制、不需要额外空间。挪不动（应用还开着、文件被占用）就什么都不做
; —— 结果与改动前一致，不会比现在更糟；而残留的 keep 目录会在下一次安装时被复用。
;
; 注意：**老版本卸载器执行删除**，所以这段逻辑必须放在新安装包的 customInit 里才救得到
; 老用户；装完之后（新版本卸载器带这段）每次升级都会自动保住数据。
!include "LogicLib.nsh"

; 备份目录名（安装目录同级）。带前缀避免与用户自己的目录撞名。
!define DSH_PET_DATA_KEEP "$INSTDIR\..\dsh-pet-ng-data-keep"

!macro customInit
  ; 上一次安装被取消时可能残留：先清掉，再挪这次的
  RMDir /r "${DSH_PET_DATA_KEEP}"
  ${If} ${FileExists} "$INSTDIR\data\*.*"
    Rename "$INSTDIR\data" "${DSH_PET_DATA_KEEP}"
    ${If} ${Errors}
      ; 挪不动（多半是应用还开着）：保持原样，让安装器按老路子继续
      DetailPrint "dsh-petNG: 用户数据被占用，本次升级无法保留（请关闭 dsh-petNG 后重试）"
      ClearErrors
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ${If} ${FileExists} "${DSH_PET_DATA_KEEP}\*.*"
    CreateDirectory "$INSTDIR"
    Rename "${DSH_PET_DATA_KEEP}" "$INSTDIR\data"
    ${If} ${Errors}
      DetailPrint "dsh-petNG: 用户数据恢复失败，原数据留在 ${DSH_PET_DATA_KEEP}"
      ClearErrors
    ${EndIf}
  ${EndIf}
!macroend
