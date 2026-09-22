import * as core from '@actions/core';
import { revoke } from './authentication.js';

try {
  await revoke(process.env.INSTALLATION_TOKEN);
} catch {
  core.setFailed('installation token revocation failed');
}
