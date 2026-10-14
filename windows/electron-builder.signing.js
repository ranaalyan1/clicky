/**
 * Packaging configuration, with the signing provider chosen by environment.
 *
 * electron-builder cannot be told "use Azure only if it is configured" from
 * package.json, because package.json is static JSON. It can from a JavaScript
 * config, so the build config stays in package.json as the single source of
 * truth and this file adds the Azure signing block only when the environment
 * asks for it.
 *
 * Three states, and the third is the point:
 *
 *   1. Nothing configured                  -> unsigned installers, as before
 *   2. All four Azure values configured    -> Azure Artifact Signing
 *   3. Some, but not all, configured       -> the build fails, loudly
 *
 * The third case is the one worth having. A half-configured signing setup would
 * otherwise produce installers that look signed in the CI log and are not,
 * which is the exact failure Smart App Control reports as "we could not verify
 * its publisher" -- after the release has shipped.
 *
 * Credentials are not part of this config: electron-builder authenticates
 * through Azure's EnvironmentCredential, so the workflow supplies
 * AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET.
 */

const packageManifest = require("./package.json");

/** Each option electron-builder needs, and the secret that carries it. */
const azureSigningOptions = [
  { optionName: "endpoint", environmentVariableName: "AZURE_CODE_SIGNING_ENDPOINT" },
  { optionName: "codeSigningAccountName", environmentVariableName: "AZURE_CODE_SIGNING_ACCOUNT_NAME" },
  { optionName: "certificateProfileName", environmentVariableName: "AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME" },
  { optionName: "publisherName", environmentVariableName: "AZURE_CODE_SIGNING_PUBLISHER_NAME" },
];

const configuredAzureValues = {};
const missingEnvironmentVariableNames = [];

for (const { optionName, environmentVariableName } of azureSigningOptions) {
  const environmentValue = process.env[environmentVariableName];
  if (typeof environmentValue === "string" && environmentValue.trim() !== "") {
    configuredAzureValues[optionName] = environmentValue.trim();
  } else {
    missingEnvironmentVariableNames.push(environmentVariableName);
  }
}

const isAzureSigningConfigured = missingEnvironmentVariableNames.length === 0;
const isAzureSigningPartlyConfigured = !isAzureSigningConfigured && missingEnvironmentVariableNames.length < azureSigningOptions.length;

if (isAzureSigningPartlyConfigured) {
  throw new Error(
    `Azure code signing is partly configured. Missing: ${missingEnvironmentVariableNames.join(", ")}. ` +
      "Signing is all or nothing on purpose: set every value or none, so a release can never be published believing it is signed.",
  );
}

module.exports = {
  ...packageManifest.build,
  win: {
    ...packageManifest.build.win,
    ...(isAzureSigningConfigured ? { azureSignOptions: configuredAzureValues } : {}),
  },
};
