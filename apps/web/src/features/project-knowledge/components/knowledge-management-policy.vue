<script setup lang="ts">
import { KNOWLEDGE_ARCHITECTURE_DOCUMENTS, KNOWLEDGE_CATEGORIES, KNOWLEDGE_SPECIFICATION_DOCUMENTS } from "@codeflowai/shared";
defineProps<{ open: boolean }>();
defineEmits<{ "update:open": [value: boolean] }>();
</script>

<template>
  <a-drawer :open="open" title="规格库管理策略" width="min(640px, 100vw)" :header-style="{ padding: '8px 12px' }" :body-style="{ padding: '12px', overflowY: 'auto' }" @close="$emit('update:open', false)">
    <p>以已确认的规格约束指导开发，用架构和产品文档补充项目背景。源码可以快速查到的信息不重复生成，已有资料优先引用原文。</p>
    <section v-for="category in KNOWLEDGE_CATEGORIES" :key="category.id">
      <h3>{{ category.title }}</h3>
      <p>{{ category.summary }}</p>
      <ul v-if="category.category === 'product'"><li v-for="content in category.contents" :key="content">{{ content }}</li></ul>
      <ul v-else><li v-for="document in category.category === 'specifications' ? KNOWLEDGE_SPECIFICATION_DOCUMENTS : KNOWLEDGE_ARCHITECTURE_DOCUMENTS" :key="document.title"><strong>{{ document.title }}</strong>：{{ document.summary }}</li></ul>
      <template v-if="category.category === 'specifications'"><p>以上八份为内置默认规格文档及其作用，规格约束下始终提供全部八份文档，不由模型决定是否创建。构建时分别填写有依据的项目要求；只有一条已确认规则也可保留。没有依据的文档保持待补充，不编造通用规范，空文档不作为已生效规则加载。</p><p>一份原文可以支撑多份规格，按文档职责分别提取相关规则并保留来源，来源变化时展示更新状态。每条规则只保留一处，项目约定不汇总复制其他七份内容；不把同一份原文全文复制八遍。已有节点复用，旧库迁移或纠正分类保留原节点和正文。配置和源码可直接查询的信息不重复编写；其他专题可按需创建。</p><p>原文仅对应一个专题时可直接引用；提取或修订的正文须预览采用后生效。临时任务要求和个人偏好不保存为共享规则。全局规格随启用 Spec 的会话加载，局部规格按目标文件或目录读取，原规则的生效条件不能扩大，冲突需明确处理。</p></template>
      <template v-else-if="category.category === 'architecture'"><p>默认只补齐以上三份文档，已有有效资料优先引用；没有可信来源时逐项记录缺口，不生成占位文章。其他专题由用户在规格协作对话中按需生成，已有专题保留，可显式选择更新或按定时计划维护。</p><p>每篇只解释自身的跨模块事实，附必要来源，不重复接口、字段或逐文件清单，不推测设计理由。编码要求归规格约束，使用说明归产品文档。</p></template>
      <p v-else>选择仓库文档或上传资料后，保留原文件，按章节分块检索，结果带来源及行号。支持 Markdown、TXT、RST、AsciiDoc；其他格式需先转为文本。原文变化后检索读取最新内容，并展示变化状态。</p>
    </section>
    <a-divider />
    <p>一级目录固定为三类，规格约束内置八份默认文档，系统架构默认保留三份基础文档，其余专题按需创建。按内容用途归类：导入的编码规范属于规格约束，架构设计属于系统架构。</p>
    <p>一键生成会筛选来源、组织目录，只生成必要说明，最后统一预览采用。产品文档保留原文，不参与自动正文生成；历史方案、废弃需求、过程报告和全仓 Markdown 不默认收录。</p>
    <p>目录和内容变更先预览采用；已采用引用实时读取原文，索引随来源更新，不产生重复正文。权限和原文中的指令不能由知识内容改变。</p>
  </a-drawer>
</template>
