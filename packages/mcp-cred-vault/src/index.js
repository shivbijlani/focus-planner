// @focus/mcp-cred-vault
//
// This package is primarily a Windows PowerShell + .NET Framework toolchain
// (see bin/ and src/mcp-cred-launch.cs). The JS surface exists so the pointer
// file schema can be validated and unit-tested alongside sibling packages.
export {
  collectMcpSecretsErrors,
  isValidMcpSecrets,
  parseMcpSecrets,
} from './schema.js';
