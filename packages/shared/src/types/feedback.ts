export type FeedbackType = "bug" | "feature" | "other";
export type FeedbackSource = "user_menu" | "tray" | "slash_command";

export type FeedbackEnvironment = {
  appVersion: string | null;
  clientVersion: string | null;
  platform: string | null;
  mainView: string | null;
  workspaceId: string | null;
};

export type FeedbackAttachmentInput = {
  name: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  dataBase64: string;
};

export type SubmitFeedbackRequestBody = {
  type: FeedbackType;
  title?: string;
  content: string;
  contactEmail?: string;
  source: FeedbackSource;
  environment?: FeedbackEnvironment;
  attachments?: FeedbackAttachmentInput[];
};

export type SubmitFeedbackResponseBody = { ticketNo: string; id: string };
