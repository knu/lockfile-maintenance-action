import * as core from '@actions/core';
import { AuthenticationError, authenticate, requestIdentity } from './authentication.js';

try {
  const token = await authenticate({
    mode: process.env.INPUT_AUTH,
    token: process.env.INPUT_TOKEN,
    getIDToken: (audience) => requestIdentity(audience, process.env),
    mask: core.setSecret,
  });
  core.setOutput('token', token);
} catch (error) {
  core.setFailed(error instanceof AuthenticationError ? error.message : 'authentication failed');
}
