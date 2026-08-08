/**
 * job-breakaway launcher の実行入口。WMI から `node <このファイル>` として起動される。
 *
 * 実体は breakaway-launcher.ts。ここは「プロセスとして走る」責務だけを持ち、
 * ライブラリ側を副作用なく import/テストできるように分けてある。
 */
import { launchBreakawayChild, readLaunchSpec } from './breakaway-launcher.js';

const { spec, childEnv } = readLaunchSpec(process.env);
process.exitCode = await launchBreakawayChild(spec, childEnv);
