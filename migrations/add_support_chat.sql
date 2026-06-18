CREATE TABLE IF NOT EXISTS support_chats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL UNIQUE,
  telegram_username VARCHAR(255),
  telegram_first_name VARCHAR(255),
  telegram_last_name VARCHAR(255),
  linked_user_id INT,
  last_message_text TEXT,
  last_message_at TIMESTAMP NULL,
  last_message_direction ENUM('incoming', 'outgoing'),
  is_read TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_linked_user (linked_user_id)
);

CREATE TABLE IF NOT EXISTS support_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chat_id INT NOT NULL,
  telegram_message_id BIGINT,
  direction ENUM('incoming', 'outgoing') NOT NULL,
  text TEXT,
  attachment_type VARCHAR(50),
  attachment_file_id VARCHAR(255),
  admin_id INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_chat_time (chat_id, created_at),
  FOREIGN KEY (chat_id) REFERENCES support_chats(id)
);
