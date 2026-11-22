// startup-launcher.js — 生产守护开机自启（WSH 隐藏窗口拉起 sup-launch.mjs）
// 安装时由 scripts/install-startup.mjs 复制到 Startup 目录；这里用相对推导定位仓库根，
// 不写死任何盘符或用户名。
var sh = new ActiveXObject("WScript.Shell");
var fso = new ActiveXObject("Scripting.FileSystemObject");
var here = fso.GetParentFolderName(WScript.ScriptFullName);
var target = fso.GetParentFolderName(here) + "\\scripts\\sup-launch.mjs";
sh.Run('"node.exe" "' + target + '"', 0, false);
