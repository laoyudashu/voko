# VOKO Lite のアンインストール

[ドキュメント一覧](README.md) · [中文](uninstall.md) · [English](uninstall.en.md)

`voko uninstall` は `voko stop` と同じプロセス識別検証を使い、VOKO と一致する Worker を完全に停止し、MCP・Provider 設定の残存箇所と適切な npm 削除コマンドを表示します。npm の実行、Provider サービスの停止、他製品の設定変更は行いません。既に停止済みの場合や繰り返し実行も正常終了します。

```bash
voko uninstall                 # データを保持して削除準備
voko uninstall --dry-run       # 停止・削除なしのプレビュー
voko uninstall --json          # 機械可読出力
```

既定では再インストールに備えて `voko.db` を含むローカルデータを保持します。既定ディレクトリは Windows が `%APPDATA%\voko`、macOS が `~/Library/Application Support/voko`、Linux が `$XDG_CONFIG_HOME/voko` または `~/.config/voko` です。

完全削除には `voko uninstall --purge` を使い、`DELETE VOKO DATA` と入力します。非対話環境では明示的な `voko uninstall --purge --yes` が必須です。独自の `--db` / `VOKO_DB_PATH`、ルート、ホーム、シンボリックリンク、ジャンクション、不明確な対象は自動削除しません。

明確に VOKO を参照する MCP 項目と、OpenClaw / Hermes の設定で関与した可能性がある場所だけを報告します。設定本文、Token、秘密情報は表示しないため、報告された場所は手動で確認してください。

AgentDID アカウント、リモート Agent、サーバーメッセージ、許可リストなどのクラウドデータは削除されず、別のリモート管理手順が必要です。
