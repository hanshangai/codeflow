import path from "node:path";
import { pathToFileURL } from "node:url";
import { runPublicationCli } from "../../../tools/release/desktop-publication.mjs";

export { preparePublication, verifyPreparedPublication } from "../../../tools/release/desktop-publication.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runPublicationCli();
