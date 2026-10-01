import { VaultCard } from '../components/VaultCard';

/** 環境変数タブ: 本社の Vault (Infisical の置き換え) を設定する。 */
export default function Env() {
  return (
    <div className="config">
      <VaultCard />
    </div>
  );
}
