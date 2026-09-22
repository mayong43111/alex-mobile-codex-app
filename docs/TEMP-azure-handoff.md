# Azure GPU 临时交接记录

公开脱敏副本：以下名称、订阅 ID、工单、网络地址和路径均为示例或占位符，不可据此操作真实资源。恢复工作必须使用私有运维记录重新核验，GPU 任务仍暂停。

更新时间：2026-09-22。用户要求暂停机器申请和启动重试，先开发应用。本文记录最近一次已验证状态，不代表实时查询；不要自动重试、定时启动或创建替代 VM。

## 已批准的部署约束

- 新资源订阅：`example-hosting-subscription`，`00000000-0000-0000-0000-000000000000`。
- 区域：`southeastasia`，与开发 VM 同区域。
- 只部署 1 台 `Standard_NC24ads_A100_v4` Spot，24 vCPU、220GiB RAM、1 张 A100；`maxPrice=1.00` USD/小时，`evictionPolicy=Deallocate`，不指定可用区。
- 最近公开 Linux Spot 报价 $0.88242/小时，查询于 2026-09-22 01:33 UTC；不是未来报价或容量保证。
- 系统盘请求为 128GiB Standard SSD LRS，参考价 $9.60/月，磁盘操作另计。VM 释放不等于磁盘免费。
- 不自动切换按需、更大机型、其他区域或其他订阅。

## 已创建的资源

| 资源 | 名称或状态 |
| --- | --- |
| 资源组 | `rg-example-gpu` |
| VNet / 子网 | `vnet-example-gpu`：`10.20.0.0/24`；`gpu`：`10.20.0.0/27` |
| 网卡 | `nic-example-gpu`，固定私网 IP `10.20.0.4`，加速网络已关闭 |
| NSG | `nsg-example-gpu`；优先级 100 仅允许 `10.10.0.4/32` 到 GPU 的 TCP 22、8188；优先级 200 拒绝其他入站 |
| VM | `vm-example-gpu`，Ubuntu 24.04 Gen2，最后回读 `PowerState/deallocated` |
| 系统盘 | `osdisk-example-gpu`，`StandardSSD_LRS`，`Reserved`；磁盘 API 容量字段为空，尚不能确认初始化完成；保留存储可能计费 |
| 公网 IP | 无，创建失败，列表为空 |
| Peering | 新网络 `to-example-developer` / 旧网络 `to-example-gpu`，双向连接已返回 `Connected` |

现有开发机位于第一订阅 `00000000-0000-0000-0000-000000000000`，资源组 `rg-example-developer`，VM `vm-example-developer`，VNet `vnet-example-developer`（`10.10.0.0/24`），开发机私网地址 `10.10.0.4`。现有 NSG 未修改。不启用网关传递或任意转发。

## 阻塞及已尝试操作

1. Spot 配额已确认：新加坡 `lowPriorityCores` 为 100，使用 0。A100 SKU `restrictions=[]`，普通 A100 家族配额为 0 不代表 Spot 配额不足。
2. A100 创建返回 `OverconstrainedAllocationRequest`。释放、关闭加速网络后启动同一 VM，再次失败；错误只剩 Low Priority、Preemptible、VM Size。未成功拿到 GPU，不是已证实的价格上限或配额错误。
3. 最后已执行 deallocate 并回读确认。没有 GPU 正在运行；驱动、ComfyUI、模型、Codex 均未安装，没有出图测试。
4. Standard 公网 IPv4 的 CLI 与最小 REST 请求均报 `SubscriptionNotRegisteredForFeature: Microsoft.Network/AllowBringYourOwnPublicIpAddress`。没有申请该额外功能。用户已改为批准当前开发机的受控代理出口，经私网 SSH 隧道提供；代理尚未配置。不要开放匿名公网代理或创建 NAT Gateway。
5. T4 历史 SKU 访问工单 `REDACTED_TICKET_ID`，资源名 `example-support-request`，提交后确认 `Open`。申请预期 64 vCPU；不增加现有 Spot 配额。它不是 A100 申请，当前无需等待它才能尝试 A100。

## 稍后恢复步骤

用户明确要求恢复时，先只读核验状态、Spot 价格和配额，再对同一 VM 尝试启动，避免重复创建：

```bash
AZ="$HOME/.local/share/qwen-azure-cli/bin/az"
SUB="00000000-0000-0000-0000-000000000000"
RG="rg-example-gpu"
VM="vm-example-gpu"
"$AZ" vm get-instance-view --subscription "$SUB" -g "$RG" -n "$VM" \
  --query 'instanceView.statuses' -o json
"$AZ" vm show --subscription "$SUB" -g "$RG" -n "$VM" \
  --query '{size:hardwareProfile.vmSize,priority:priority,maxPrice:billingProfile.maxPrice,eviction:evictionPolicy}' -o json
```

确认仍为 A100 Spot、上限 1.00 后，按用户的恢复指令执行：

```bash
"$AZ" vm start --subscription "$SUB" -g "$RG" -n "$VM"
```

若仍失败，释放并确认电源状态，不自动循环重试：

```bash
"$AZ" vm deallocate --subscription "$SUB" -g "$RG" -n "$VM"
"$AZ" vm get-instance-view --subscription "$SUB" -g "$RG" -n "$VM" \
  --query 'instanceView.statuses' -o json
```

成功后先验证私网 SSH 和磁盘，专用私钥为 `~/.ssh/example-gpu-key`，不要打印或复制进仓库。配置受控代理、驱动、ComfyUI、Qwen-Image-2.1。实际生成可解码、尺寸正确的图片并回收到开发机后，才安装 Codex/OpenMontage。Codex 必须使用原有 GPT-5.4 服务，endpoint/provider/部署名/认证配置仍待核实，不要猜测。应用开发阶段不安装这些 GPU 侧组件，也不调用付费替代模型。