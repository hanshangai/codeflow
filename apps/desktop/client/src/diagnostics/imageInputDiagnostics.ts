export type ImageInputDiagnostics = {
  imageCount: number;
  nonEmptyImageCount: number;
  emptyImageCount: number;
  dataUrlCount: number;
  malformedDataUrlCount: number;
  remoteUrlCount: number;
  localPathCount: number;
  otherCount: number;
};

/** 只统计图片输入形态，不记录图片内容、Base64 或原始路径。 */
export function summarizeImageInputs(images: readonly unknown[]): ImageInputDiagnostics {
  const result: ImageInputDiagnostics = {
    imageCount: images.length,
    nonEmptyImageCount: 0,
    emptyImageCount: 0,
    dataUrlCount: 0,
    malformedDataUrlCount: 0,
    remoteUrlCount: 0,
    localPathCount: 0,
    otherCount: 0,
  };

  for (const image of images) {
    const value = String(image ?? "").trim();
    if (!value) {
      result.emptyImageCount += 1;
      continue;
    }
    result.nonEmptyImageCount += 1;
    if (value.startsWith("data:")) {
      result.dataUrlCount += 1;
      const commaIndex = value.indexOf(",");
      const header = commaIndex >= 0 ? value.slice(5, commaIndex) : "";
      const payload = commaIndex >= 0 ? value.slice(commaIndex + 1).trim() : "";
      if (commaIndex < 0 || !/;base64$/i.test(header) || !payload) result.malformedDataUrlCount += 1;
      continue;
    }
    if (/^https?:\/\//i.test(value)) {
      result.remoteUrlCount += 1;
      continue;
    }
    if (/^(?:[a-zA-Z]:[\\/]|[\\/]{1,2}|\.\.?[\\/])/.test(value)) {
      result.localPathCount += 1;
      continue;
    }
    result.otherCount += 1;
  }

  return result;
}
