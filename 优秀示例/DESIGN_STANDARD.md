---
name: design-style-standard
description: Scene Symphony Engine UI/设计风格标准文档，用于 AI 辅助开发时保持视觉一致性
metadata:
  type: reference
---

# Scene Symphony Engine · UI 设计标准 v1.0

## 一、设计理念

**关键词**：温润 · 克制 · 杂志感 · 半专业工具

Scene Symphony Engine 是一款 AI 短剧创作实验室。视觉上追求**编辑部/工作室**的氛围——既不是冷冰冰的企业后台，也不是花哨的消费级应用。整体调性偏向**日系印刷品**的温润质感，结合现代 SaaS 工具的清晰层级。

---

## 二、色彩体系（OKLCH 色域）

### 2.1 语义色令牌

| 令牌 | 浅色模式 | 深色模式 | 用途 |
|------|---------|---------|------|
| `--background` | `oklch(0.985 0.005 110)` | `oklch(0.15 0.01 110)` | 页面底色 |
| `--foreground` | `oklch(0.15 0.01 110)` | `oklch(0.95 0.005 110)` | 正文文字 |
| `--card` | `oklch(1 0 0)` | `oklch(0.18 0.01 110)` | 卡片/面板背景 |
| `--card-foreground` | 同 `--foreground` | 同 `--foreground` | 卡片内文字 |
| `--popover` | `oklch(1 0 0)` | `oklch(0.18 0.01 110)` | 弹出层背景 |
| `--popover-foreground` | 同 `--foreground` | 同 `--foreground` | 弹出层文字 |
| `--primary` | `oklch(0.2 0.02 110)` | `oklch(0.9 0.01 110)` | 主要按钮/强调 |
| `--primary-foreground` | `oklch(0.98 0 0)` | `oklch(0.15 0.01 110)` | 主色上的文字 |
| `--secondary` | `oklch(0.96 0.005 110)` | `oklch(0.22 0.01 110)` | 次要按钮/标签 |
| `--secondary-foreground` | `oklch(0.2 0.02 110)` | `oklch(0.9 0.01 110)` | 次色上的文字 |
| `--muted` | `oklch(0.96 0.005 110)` | `oklch(0.22 0.01 110)` | 弱化背景 |
| `--muted-foreground` | `oklch(0.55 0.02 110)` | `oklch(0.65 0.02 110)` | 辅助文字 |
| `--accent` | `oklch(0.96 0.005 110)` | `oklch(0.22 0.01 110)` | 强调背景 |
| `--accent-foreground` | `oklch(0.2 0.02 110)` | `oklch(0.9 0.01 110)` | 强调文字 |
| `--destructive` | `oklch(0.55 0.15 25)` | `oklch(0.6 0.15 25)` | 删除/危险操作 |
| `--destructive-foreground` | `oklch(0.98 0 0)` | `oklch(0.98 0 0)` | 危险操作上的文字 |
| `--border` | `oklch(0.9 0.01 110)` | `oklch(0.25 0.01 110)` | 边框/分割线 |
| `--input` | `oklch(0.9 0.01 110)` | `oklch(0.25 0.01 110)` | 输入框边框 |
| `--ring` | `oklch(0.55 0.07 155)` | `oklch(0.55 0.07 155)` | 聚焦环 |

### 2.2 品牌强调色（Mint Green）

| 令牌 | 值 | 用途 |
|------|-----|------|
| `--mint` | `oklch(0.55 0.07 155)` | 图表/品牌色 |
| `--mint-deep` | `oklch(0.45 0.07 155)` | 深色变体（文字/边框） |
| `--mint-subtle` | `oklch(0.95 0.02 155)` | 浅色背景变体 |
| `--chart-1` ~ `--chart-5` | 分布在 30°/155°/190°/280°/50° 色调 | 数据可视化 |

### 2.3 高保真色板（用于 AI 模型展示）

这些是 `lib/models.ts` 中 `STYLES` 定义的色板，用于 StylePicker 组件中展示视觉风格：

| 风格 | 色板 | 用途 |
|------|------|------|
| 写实电影 | `["#2B3A42","#D4A76A","#8C5A3C","#3E2723"]` | 电影质感 |
| 日系动漫 | `["#4A90D9","#F5A623","#E84C3D","#7B68EE"]` | 动画风格 |
| 国风水墨 | `["#2C3E2D","#8B9E8B","#D4CFC4","#4A3728"]` | 水墨中国风 |
| 韩系唯美 | `["#F4C7C3","#E8D5B7","#B8C5D6","#D4A8CF"]` | 柔和韩式 |
| 美式漫画 | `["#2C3E50","#E74C3C","#3498DB","#F1C40F"]` | 漫画风格 |
| 3D卡通 | `["#FF6B6B","#4ECDC4","#FFE66D","#A8E6CF"]` | Q版卡通 |
| 赛博朋克 | `["#00F0FF","#FF00E5","#1A0030","#0AFF9D"]` | 科幻未来 |

### 2.4 阴影

| 令牌 | 值 | 用途 |
|------|-----|------|
| `--shadow-soft` | `0 2px 16px 0 oklch(0.15 0.01 110 / 0.06)` | 卡片悬浮 |
| `--shadow-glow` | `0 0 20px 0 oklch(0.55 0.07 155 / 0.3)` | 选中/高亮光晕 |

---

## 三、字体体系

### 3.1 字体族

| 用途 | 字体栈 | 权重 |
|------|--------|------|
| **正文/UI** | `"Inter", "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif` | 400 (常规), 500 (中等), 600 (半粗) |
| **标题/衬线** | `"Instrument Serif", "Songti SC", "Noto Serif SC", ui-serif, Georgia, serif` | 400 (常规) |

### 3.2 字号阶梯

| 层级 | Tailwind Class | 字号 | 行高 | 使用场景 |
|------|---------------|------|------|----------|
| h1 (页面标题) | 无固定 class，见组件 | ~30px | 1.25 | PageHeader title |
| h2 (区块标题) | `text-2xl` + `font-serif` | 24px | — | 页面内 section 标题 |
| eyebrow | `text-xs` + `tracking-widest` | 12px | — | PageHeader 眉题（如 "STEP 01"） |
| body | `text-sm` | 14px | 1.5 | 正文、描述、标签 |
| caption | `text-xs` | 12px | 1.5 | 辅助信息、时间戳 |
| micro | `text-[10px]` | 10px | — | 角标、序号标签 |

### 3.3 字重使用规则

- **标题**：`font-serif` 默认 400，不额外加粗
- **按钮/标签**：`font-medium` (500)
- **正文**：默认 400
- **强调数字/状态**：`font-semibold` (600)

---

## 四、间距系统

使用 Tailwind 默认间距阶梯（基于 4px 网格）：

| Token | 值 | 常用场景 |
|-------|-----|----------|
| `1` (4px) | 4px | 图标与文字间距 |
| `2` (8px) | 8px | 紧凑内边距、标签间距 |
| `3` (12px) | 12px | 卡片内 padding、元素间距 |
| `4` (16px) | 16px | 标准内边距、网格 gap |
| `5` (20px) | 20px | 卡片 padding（大） |
| `6` (24px) | 24px | 区块间距 |
| `8` (32px) | 32px | 大区块间距 |
| `10` (40px) | 40px | 页面级 section 间距 |

**布局宽度**：全局内容区无固定最大宽度，采用 `p-6` 全宽布局，侧边栏固定 260px。

---

## 五、圆角系统

| Token | Tailwind | 值 | 使用场景 |
|-------|----------|-----|----------|
| `sm` | `rounded-sm` | 4px | 小标签、徽章 |
| `md` | `rounded-md` | 6px | 输入框、下拉菜单 |
| `lg` | `rounded-lg` | 8px | 按钮 |
| `xl` | `rounded-xl` | 12px | 按钮（shadcn 默认）、卡片边角 |
| `2xl` | `rounded-2xl` | 16px | 图片卡片、分镜选择卡 |
| `3xl` | `rounded-3xl` | 24px | 页面级面板、大容器 |

**默认规则**：
- 按钮：`rounded-xl` (12px)
- 卡片/面板：`rounded-3xl` (24px) + `border border-border`
- 图片容器：`rounded-2xl` (16px)
- 标签/徽章：`rounded-full`（药丸形）

---

## 六、组件设计规范

### 6.1 Button（按钮）

使用 CVA（class-variance-authority）定义变体：

| 变体 | 样式 | 场景 |
|------|------|------|
| `default` | 主色背景 + 主色文字 | 主要操作（生成、保存、导出） |
| `secondary` | 次色背景 + 次色文字 | 次要操作（取消、返回） |
| `destructive` | 危险色背景 + 白色文字 | 删除、不可逆操作 |
| `outline` | 透明背景 + 边框 | 低调操作、工具栏 |
| `ghost` | 透明背景、hover 显示 | 图标按钮、行内操作 |
| `link` | 仅文字颜色 | 导航链接 |

尺寸：`default` (h-9 px-4 py-2)、`sm` (h-8 px-3)、`lg` (h-10 px-6)、`icon` (h-9 w-9)。

统一使用 `rounded-xl` 圆角 + `inline-flex items-center justify-center gap-2`。

### 6.2 Card（卡片）

```css
rounded-3xl border border-border bg-card text-card-foreground shadow-sm
```

卡片是信息容器的主要形式。页面上几乎所有的白色/浅色面板都应该使用 Card 样式。关键特征：

- **大圆角** (24px) 营造温润感
- **浅边框** (`--border`) 区分卡片与背景
- **微阴影** (`shadow-sm`) 提供轻微的浮起感
- **内边距** 通常 `p-5` (20px)

### 6.3 PageHeader（页面标题栏）

统一的页面顶部组件：

```
[eyebrow: "STEP 01" · 12px · tracking-widest · muted-foreground]
[title: font-serif · ~30px · font-normal]
[description: text-sm · muted-foreground · max-w-2xl]
```

- eyebrow 使用大写字母间距，提供"杂志目录"的视觉节奏
- title 使用衬线字体，营造编辑感
- description 限制最大宽度 42rem，保持可读性

### 6.4 EmptyState（空状态）

居中、带图标、标题+描述的占位组件。用于各页面数据为空时的引导提示。

- 图标容器：`rounded-2xl bg-mint/30 p-4`
- 标题：`font-serif text-xl`
- 描述：`text-sm text-muted-foreground`

### 6.5 StylePicker（风格选择器）

卡片式网格布局，每个卡片包含：

- 风格名称 + 简短描述
- 4 色色板条（使用 STYLES 中定义的 colors 数组）
- 选中态：`border-mint-deep ring-2 ring-mint/60`
- 默认态：`border-border hover:border-mint-deep/40`

### 6.6 ModelPicker（模型选择器）

下拉选择或按钮组，按 capability 过滤（`text` / `image` / `video`）：

- 显示厂商标签（`badge`）
- 显示模型名称和简要描述
- 选中态使用 mint 强调色

### 6.7 ProjectSidebar（项目侧边栏）

260px 固定宽度侧边栏：

- 项目名称 + 描述在顶部
- 导航链接按 STEP 编号排列（01 剧本 → 02 资产库 → 03 分镜 → 04 视频合成）
- 当前激活项：`bg-mint/40 text-mint-deep font-medium`
- 底部有返回首页链接

---

## 七、交互与状态

### 7.1 选中态

所有可选元素（分镜卡片、风格卡片、模型选项）使用统一的选中视觉：

```
border-2 border-mint-deep ring-2 ring-mint/60
```

即 mint 深色边框 + mint 半透明扩散光环。

### 7.2 Hover 态

- 可点击卡片：`hover:border-mint-deep/40`（mint 浅边框）
- 按钮/链接：组件库默认行为
- 删除按钮：默认隐藏 (`hidden`)，父级 hover 时显示 (`group-hover:flex`)

### 7.3 加载/进行中

- 异步操作时按钮 `disabled` + 文字变化
- Toast 通知（sonner）：`info` 进行中 → `success` 完成 / `error` 失败

### 7.4 拖拽排序（分镜）

使用 `@dnd-kit/core` + `@dnd-kit/sortable`：

- 拖拽手柄：`GripVertical` 图标，在卡片左侧
- 拖拽覆盖层：`z-50 opacity-80 shadow-glow`
- 过渡动画：使用 `@dnd-kit/utilities` 的 CSS transform

---

## 八、响应式策略

| 断点 | 宽度 | 适配策略 |
|------|------|----------|
| 默认 | < 640px | 单列、全宽按钮 |
| `sm` | ≥ 640px | 3 列网格 |
| `md` | ≥ 768px | 4 列网格、并排面板 |
| `lg` | ≥ 1024px | 5 列网格 |

- 网格使用 `grid gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5` 渐进式列数
- 侧边栏在小屏下隐藏
- 视频/图片始终保持 `aspect-video` 比例

---

## 九、图标

使用 `lucide-react` 图标库：

| 图标 | 场景 |
|------|------|
| `Wand2` | AI 生成/魔法操作 |
| `Film` | 分镜/视频相关 |
| `Play` | 播放/预览 |
| `Trash2` | 删除 |
| `GripVertical` | 拖拽手柄 |
| `Plus` | 新增 |
| `Image` | 图片/资产 |
| `FileText` | 剧本/文档 |
| `Layout` | 项目概览 |
| `Lock` / `Star` | **不使用**——这些来自旧代码，已在清理中移除 |

---

## 十、文案风格

- **中文为主**，技术术语保留英文（如 JSON、Mock、AI 模型名）
- **简洁指令式**：按钮用动词（"生成剧本"、"导出成片"、"保存"）
- **眉题用英文大写**：STEP 01、STEP 02... 形成节奏感
- **描述用完整句子**：为用户提供上下文，而非仅标签
- **Toast 通知用正在进行时**："正在生成…" → "生成完成"

---

## 十一、代码规范

### 11.1 文件组织

```
src/
├── components/
│   ├── ui/          # shadcn/ui 基础组件 (button, card, input...)
│   └── app/         # 业务组件 (PageHeader, ModelPicker, StylePicker, EmptyState, ProjectLayout, ProjectSidebar)
├── lib/
│   ├── store/       # Zustand 状态管理
│   ├── types.ts     # 类型定义
│   ├── models.ts    # AI 模型/风格常量
│   ├── mock.ts      # Mock 数据生成
│   └── utils.ts     # cn() 工具函数
├── routes/          # 文件路由 (TanStack Start)
└── styles.css       # 全局样式 + CSS 变量
```

### 11.2 组件编写规则

- 使用 `export function` 命名导出（非 default export）
- Props 类型使用 `interface` 内联定义
- 使用 `cn()` (clsx + tailwind-merge) 合并类名
- 条件类名使用 `cn("base", condition && "conditional")` 模式
- 禁止 emoji（除非用户明确要求）
- 不加注释（除非非显而易见的 WHY）

### 11.3 状态管理规则

- Zustand store 中所有实体以 `Map<string, T>` 或 `T[]` 存储
- 获取带过滤的数据时，先用稳定 selector 取原始数据，再 `useMemo` 过滤——**禁止在 selector 中直接 `.filter()`**
- 删除操作必须级联清理关联数据

---

## 十二、背景纹理

`.bg-grain` 类提供细微的噪点纹理效果，用于页面背景增加质感：

```css
.bg-grain {
  background-image: url("data:image/svg+xml,...");
  background-repeat: repeat;
  background-size: 200px 200px;
}
```

仅在浅色模式下可见，深色模式自动隐藏（通过 `dark:hidden` 控制伪元素）。