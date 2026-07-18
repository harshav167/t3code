export interface RpcExtensionUIResponse {
  readonly type: "extension_ui_response";
  readonly id: string;
  readonly confirmed?: boolean;
  readonly value?: string;
  readonly cancelled?: boolean;
}

export type RpcExtensionUIRequest =
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "select";
      readonly title: string;
      readonly options: ReadonlyArray<string>;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "confirm";
      readonly title: string;
      readonly message: string;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "input";
      readonly title: string;
      readonly placeholder?: string;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "editor";
      readonly title: string;
      readonly prefill?: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "notify";
      readonly message: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setStatus";
      readonly statusKey: string;
      readonly statusText?: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setWidget";
      readonly widgetKey: string;
      readonly widgetLines?: ReadonlyArray<string>;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setTitle";
      readonly title: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "set_editor_text";
      readonly text: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "cancel";
      readonly targetId: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "open_url";
      readonly url: string;
      readonly launchUrl?: string;
      readonly instructions?: string;
    };
