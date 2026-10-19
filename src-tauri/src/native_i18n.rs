#[derive(Clone, Copy)]
pub(crate) enum NativeText {
    OpenMainWindow,
    Quit,
    CoreStatusWorking,
    CoreStatusNotInstalled,
    CoreStatusRunning,
    CoreStatusStopped,
    CoreStatusChecking,
    Working,
    StopCore,
    StartCore,
    RestartCore,
    TooltipCoreWorking,
    TooltipCoreNotInstalled,
    TooltipCoreRunning,
    TooltipCoreStopped,
    TooltipCoreOperationFailed,
    OperationFailed,
}

pub(crate) fn native_text(locale: &str, text: NativeText) -> &'static str {
    match super::normalize_app_locale(locale) {
        "zh-CN" => match text {
            NativeText::OpenMainWindow => "打开主界面",
            NativeText::Quit => "退出",
            NativeText::CoreStatusWorking => "内核状态：处理中",
            NativeText::CoreStatusNotInstalled => "内核状态：未安装",
            NativeText::CoreStatusRunning => "内核状态：运行中",
            NativeText::CoreStatusStopped => "内核状态：已停止",
            NativeText::CoreStatusChecking => "内核状态：正在检查",
            NativeText::Working => "处理中...",
            NativeText::StopCore => "停止内核",
            NativeText::StartCore => "启动内核",
            NativeText::RestartCore => "重启内核",
            NativeText::TooltipCoreWorking => "Tim’s AI Hub · 内核处理中",
            NativeText::TooltipCoreNotInstalled => "Tim’s AI Hub · 内核未安装",
            NativeText::TooltipCoreRunning => "Tim’s AI Hub · 内核运行中",
            NativeText::TooltipCoreStopped => "Tim’s AI Hub · 内核已停止",
            NativeText::TooltipCoreOperationFailed => "Tim’s AI Hub · 内核操作失败",
            NativeText::OperationFailed => "操作失败",
        },
        "zh-TW" => match text {
            NativeText::OpenMainWindow => "開啟主介面",
            NativeText::Quit => "退出",
            NativeText::CoreStatusWorking => "核心狀態：處理中",
            NativeText::CoreStatusNotInstalled => "核心狀態：未安裝",
            NativeText::CoreStatusRunning => "核心狀態：執行中",
            NativeText::CoreStatusStopped => "核心狀態：已停止",
            NativeText::CoreStatusChecking => "核心狀態：正在檢查",
            NativeText::Working => "處理中...",
            NativeText::StopCore => "停止核心",
            NativeText::StartCore => "啟動核心",
            NativeText::RestartCore => "重新啟動核心",
            NativeText::TooltipCoreWorking => "Tim’s AI Hub · 核心處理中",
            NativeText::TooltipCoreNotInstalled => "Tim’s AI Hub · 核心未安裝",
            NativeText::TooltipCoreRunning => "Tim’s AI Hub · 核心執行中",
            NativeText::TooltipCoreStopped => "Tim’s AI Hub · 核心已停止",
            NativeText::TooltipCoreOperationFailed => "Tim’s AI Hub · 核心操作失敗",
            NativeText::OperationFailed => "操作失敗",
        },
        "ja" => match text {
            NativeText::OpenMainWindow => "メイン画面を開く",
            NativeText::Quit => "終了",
            NativeText::CoreStatusWorking => "コア状態：処理中",
            NativeText::CoreStatusNotInstalled => "コア状態：未インストール",
            NativeText::CoreStatusRunning => "コア状態：実行中",
            NativeText::CoreStatusStopped => "コア状態：停止済み",
            NativeText::CoreStatusChecking => "コア状態：確認中",
            NativeText::Working => "処理中...",
            NativeText::StopCore => "コアを停止",
            NativeText::StartCore => "コアを起動",
            NativeText::RestartCore => "コアを再起動",
            NativeText::TooltipCoreWorking => "Tim’s AI Hub · コア処理中",
            NativeText::TooltipCoreNotInstalled => "Tim’s AI Hub · コア未インストール",
            NativeText::TooltipCoreRunning => "Tim’s AI Hub · コア実行中",
            NativeText::TooltipCoreStopped => "Tim’s AI Hub · コア停止済み",
            NativeText::TooltipCoreOperationFailed => "Tim’s AI Hub · コア操作失敗",
            NativeText::OperationFailed => "操作に失敗しました",
        },
        _ => match text {
            NativeText::OpenMainWindow => "Open Main Window",
            NativeText::Quit => "Quit",
            NativeText::CoreStatusWorking => "Core status: Working",
            NativeText::CoreStatusNotInstalled => "Core status: Not installed",
            NativeText::CoreStatusRunning => "Core status: Running",
            NativeText::CoreStatusStopped => "Core status: Stopped",
            NativeText::CoreStatusChecking => "Core status: Checking",
            NativeText::Working => "Working...",
            NativeText::StopCore => "Stop Core",
            NativeText::StartCore => "Start Core",
            NativeText::RestartCore => "Restart Core",
            NativeText::TooltipCoreWorking => "Tim’s AI Hub · Core working",
            NativeText::TooltipCoreNotInstalled => "Tim’s AI Hub · Core not installed",
            NativeText::TooltipCoreRunning => "Tim’s AI Hub · Core running",
            NativeText::TooltipCoreStopped => "Tim’s AI Hub · Core stopped",
            NativeText::TooltipCoreOperationFailed => "Tim’s AI Hub · Core operation failed",
            NativeText::OperationFailed => "Operation failed",
        },
    }
}

pub(crate) fn native_operation_failed(locale: &str, summary: &str) -> String {
    let separator = if super::normalize_app_locale(locale) == "en" {
        ": "
    } else {
        "："
    };
    format!(
        "{}{separator}{summary}",
        native_text(locale, NativeText::OperationFailed)
    )
}
