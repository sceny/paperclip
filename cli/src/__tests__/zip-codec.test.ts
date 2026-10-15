import { describe, expect, it } from "vitest";
import { bytesToPortableFileEntry, isBlobStorePath, readZipArchive } from "../commands/client/zip.js";
import { createStoredZipArchive } from "./helpers/zip.js";

describe("isBlobStorePath", () => {
  it("matches blobs/ entries at the archive root and under a package root", () => {
    expect(isBlobStorePath("blobs/4f2d1c9a")).toBe(true);
    expect(isBlobStorePath("paperclip-demo/blobs/4f2d1c9a")).toBe(true);
    expect(isBlobStorePath("tasks/pap-1/TASK.md")).toBe(false);
    expect(isBlobStorePath("blobs/nested/file")).toBe(false);
  });
});

describe("bytesToPortableFileEntry", () => {
  it("decodes valid UTF-8 entries to text", () => {
    const bytes = new TextEncoder().encode("# Notes\n\ncafé ✅\n");
    expect(bytesToPortableFileEntry("tasks/pap-1/TASK.md", bytes)).toBe("# Notes\n\ncafé ✅\n");
  });
});

describe("readZipArchive", () => {
  it("round-trips blob and invalid UTF-8 entries byte-exactly", async () => {
    const blobBytes = new Uint8Array([0x68, 0x69]);
    const invalidUtf8 = new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0xc0]);
    const archive = createStoredZipArchive(
      {
        "COMPANY.md": "# Company\n",
        "blobs/4f2d1c9a": blobBytes,
        "notes/raw": invalidUtf8,
      },
      "paperclip-demo",
    );

    await expect(readZipArchive(archive)).resolves.toEqual({
      rootPath: "paperclip-demo",
      files: {
        "COMPANY.md": "# Company\n",
        "blobs/4f2d1c9a": {
          encoding: "base64",
          data: Buffer.from(blobBytes).toString("base64"),
          contentType: "application/octet-stream",
        },
        "notes/raw": {
          encoding: "base64",
          data: Buffer.from(invalidUtf8).toString("base64"),
          contentType: "application/octet-stream",
        },
      },
    });
  });
});
