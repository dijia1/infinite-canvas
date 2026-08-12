# 后端数据库说明

后端使用 GORM 管理数据库连接和表结构迁移，支持 SQLite、MySQL 和 PostgreSQL。

当前启动时执行 `AutoMigrate`，维护以下表：

- `users`
- `prompts`
- `assets`
- `settings`

## users

仅保存管理员账号，用于管理后台登录。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `username` | string | 管理员用户名，唯一索引 |
| `password` | string | 密码哈希 |
| `role` | string | 固定为 `admin` |
| `status` | string | 固定为 `active` |
| `last_login_at` | string | 最近登录时间 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

## prompts

保存管理员手工维护的公开提示词、分类和预览内容。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `title` | string | 标题 |
| `cover_url` | string | 封面图 |
| `prompt` | string | 提示词内容 |
| `tags` | json | 标签列表 |
| `category` | string | 分类标识 |
| `preview` | text | Markdown 展示内容 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

## assets

保存服务器公开素材库中的文本、图片或视频信息。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `title` | string | 标题 |
| `type` | string | `text`、`image` 或 `video` |
| `cover_url` | string | 封面地址 |
| `tags` | json | 标签列表 |
| `category` | string | 分类 |
| `description` | text | 描述 |
| `content` | text | 文本内容 |
| `url` | string | 资源地址 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

## settings

系统设置固定保存 `public` 和 `private` 两行，配置值为 JSON。公开配置包含可用模型和默认模型；私有配置包含模型渠道和 API Key。完整结构见 [系统配置数据结构](system-settings.md)。

项目不为旧数据库编写字段兼容或清理迁移；已有数据库中停止使用的旧列和旧表不会由 `AutoMigrate` 自动删除。
