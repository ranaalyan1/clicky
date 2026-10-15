import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * The packaging config chooses a signing provider from the environment, so a
 * half-configured signing setup must fail the build rather than quietly produce
 * unsigned installers that CI then reports as signed.
 */

const signingConfigPath = "../../electron-builder.signing.js";

const azureSigningVariableNames = [
  "AZURE_CODE_SIGNING_ENDPOINT",
  "AZURE_CODE_SIGNING_ACCOUNT_NAME",
  "AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME",
  "AZURE_CODE_SIGNING_PUBLISHER_NAME",
] as const;

const completeAzureConfiguration: Record<(typeof azureSigningVariableNames)[number], string> = {
  AZURE_CODE_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
  AZURE_CODE_SIGNING_ACCOUNT_NAME: "UstaadSigningAccount",
  AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME: "UstaadCertificate",
  AZURE_CODE_SIGNING_PUBLISHER_NAME: "Ustaad contributors",
};

interface SigningConfig {
  productName: string;
  nsis: { shortcutName: string };
  win: { signExts: string[]; azureSignOptions?: Record<string, string> };
}

/**
 * The config reads the environment once, when it is first required, so each
 * case has to run against a clean copy of the module and a clean environment.
 */
function loadSigningConfigWith(environment: Partial<Record<string, string>>): SigningConfig {
  const savedValues = new Map<string, string | undefined>();
  for (const variableName of azureSigningVariableNames) {
    savedValues.set(variableName, process.env[variableName]);
    const requestedValue = environment[variableName];
    if (requestedValue === undefined) {
      delete process.env[variableName];
    } else {
      process.env[variableName] = requestedValue;
    }
  }

  try {
    delete require.cache[require.resolve(signingConfigPath)];
    return require(signingConfigPath) as SigningConfig;
  } finally {
    for (const [variableName, savedValue] of savedValues) {
      if (savedValue === undefined) {
        delete process.env[variableName];
      } else {
        process.env[variableName] = savedValue;
      }
    }
    delete require.cache[require.resolve(signingConfigPath)];
  }
}

describe("electron-builder signing configuration", () => {
  it("keeps the ordinary packaging settings from package.json", () => {
    const signingConfig = loadSigningConfigWith({});

    assert.equal(signingConfig.productName, "Hitodama Open");
    assert.equal(signingConfig.nsis.shortcutName, "Hitodama Open");
    // The .node extension matters: uiohook-napi's native module is otherwise
    // left unsigned, and a signed app that loads it is refused on its own terms.
    assert.deepEqual(signingConfig.win.signExts, [".node"]);
  });

  it("produces unsigned installers when no provider is configured", () => {
    const signingConfig = loadSigningConfigWith({});

    assert.equal("azureSignOptions" in signingConfig.win, false);
  });

  it("signs with Azure when every value is present", () => {
    const signingConfig = loadSigningConfigWith(completeAzureConfiguration);

    assert.deepEqual(signingConfig.win.azureSignOptions, {
      endpoint: completeAzureConfiguration.AZURE_CODE_SIGNING_ENDPOINT,
      codeSigningAccountName: completeAzureConfiguration.AZURE_CODE_SIGNING_ACCOUNT_NAME,
      certificateProfileName: completeAzureConfiguration.AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME,
      publisherName: completeAzureConfiguration.AZURE_CODE_SIGNING_PUBLISHER_NAME,
    });
  });

  it("ignores whitespace-only values instead of signing with blanks", () => {
    const blankConfiguration = {
      ...completeAzureConfiguration,
      AZURE_CODE_SIGNING_PUBLISHER_NAME: "   ",
    };

    assert.throws(() => loadSigningConfigWith(blankConfiguration), /AZURE_CODE_SIGNING_PUBLISHER_NAME/);
  });

  it("fails the build when Azure signing is only partly configured", () => {
    const partialConfiguration = { ...completeAzureConfiguration };
    delete (partialConfiguration as Partial<typeof completeAzureConfiguration>).AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME;

    assert.throws(
      () => loadSigningConfigWith(partialConfiguration),
      /AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME/,
      "a partially signed build must not reach a release",
    );
  });
});
