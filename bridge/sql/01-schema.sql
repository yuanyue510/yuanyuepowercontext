-- 记仇客栈 · seekdb 数据库初始化（MySQL 兼容模式）
-- 用法: obclient -h127.0.0.1 -P2881 -uroot -p'' < 01-schema.sql

CREATE DATABASE IF NOT EXISTS tavern DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE tavern;

-- 客官状态：信誉分 / 欠账 / 通缉等级
CREATE TABLE IF NOT EXISTS players (
  player      VARCHAR(64)  NOT NULL COMMENT '客官名号（跨会话主键）',
  reputation  INT          NOT NULL DEFAULT 50  COMMENT '信誉分 0-100',
  debt        INT          NOT NULL DEFAULT 0   COMMENT '欠账（文）',
  bounty      INT          NOT NULL DEFAULT 0   COMMENT '通缉等级 0-5',
  visits      INT          NOT NULL DEFAULT 0   COMMENT '进店次数',
  last_seen   DATETIME     NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player)
) COMMENT='客官档案';

-- 三娘的账本：每一次互动落一条，跨会话复读
CREATE TABLE IF NOT EXISTS ledger (
  id        BIGINT       NOT NULL AUTO_INCREMENT,
  player    VARCHAR(64)  NOT NULL,
  ts        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind      VARCHAR(16)  NOT NULL COMMENT '砍价/赖账/吹牛/顺手牵羊/请客/还钱/挑衅/帮忙/打赏',
  summary   VARCHAR(255) NOT NULL COMMENT '发生了什么',
  quote     VARCHAR(255) NOT NULL COMMENT '三娘当时记在账上的原话（下次翻旧账会原样引用）',
  severity  TINYINT      NOT NULL DEFAULT 1 COMMENT '1-5',
  amount    INT          NOT NULL DEFAULT 0 COMMENT '涉及银钱（文）',
  PRIMARY KEY (id),
  KEY idx_player_ts (player, ts),
  KEY idx_player_sev (player, severity),
  KEY idx_kind (kind)
) COMMENT='三娘的账本';

-- 客栈设定与江湖传闻：按玩家话头检索，保证世界观不跑偏
CREATE TABLE IF NOT EXISTS lore (
  id        INT          NOT NULL AUTO_INCREMENT,
  category  VARCHAR(24)  NOT NULL COMMENT '规矩/人物/菜品/传闻/地点',
  title     VARCHAR(64)  NOT NULL,
  content   TEXT         NOT NULL,
  tags      VARCHAR(128) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY idx_category (category),
  KEY idx_title (title)
) COMMENT='客栈设定集';

-- 菜单：价格随信誉浮动，由桥接服务计算
CREATE TABLE IF NOT EXISTS menu (
  item        VARCHAR(32)  NOT NULL,
  base_price  INT          NOT NULL COMMENT '基准价（文）',
  description VARCHAR(128) NOT NULL,
  PRIMARY KEY (item)
) COMMENT='三娘菜单';
