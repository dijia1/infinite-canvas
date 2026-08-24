package model

// PrivateFolder groups image media owned by one Portal user. An empty ParentID
// represents that user's root directory.
type PrivateFolder struct {
	ID        string `json:"id" gorm:"primaryKey"`
	OwnerUID  string `json:"-" gorm:"uniqueIndex:idx_private_folder_owner_parent_title"`
	ParentID  string `json:"parentId" gorm:"uniqueIndex:idx_private_folder_owner_parent_title"`
	Title     string `json:"title" gorm:"uniqueIndex:idx_private_folder_owner_parent_title"`
	CreatedAt string `json:"createdAt"`
}

type PrivateFolderList struct {
	Items []PrivateFolder `json:"items"`
	Total int             `json:"total"`
}

type PrivateImageList struct {
	Items []Media `json:"items"`
	Total int     `json:"total"`
}
